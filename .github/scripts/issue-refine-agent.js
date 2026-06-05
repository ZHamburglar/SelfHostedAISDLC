#!/usr/bin/env node

/**
 * Issue Refine Agent
 *
 * Triggered when an issue comment starts with "refine" or "/refine".
 * - Reads the user's feedback from the comment (everything after the trigger word)
 * - Finds the most recent Issue Clarity Agent review comment to retrieve previous suggestions
 * - Re-runs the LM Studio review incorporating the user's feedback to adjust, remove, or add suggestions
 * - Posts a fresh review comment with updated checkboxes
 *
 * Use this before applying changes if you want to push back on a suggestion, drop irrelevant ones,
 * or steer the review in a different direction.
 * Example: "refine: drop the testing suggestion, we already have full coverage"
 */

const fs = require("fs");
const path = require("path");

const {
  GITHUB_TOKEN,
  LM_STUDIO_URL,
  LM_STUDIO_MODEL,
  ISSUE_NUMBER,
  ISSUE_TITLE,
  ISSUE_BODY,
  REFINE_COMMENT,
  REPO,
} = process.env;

const EXCLUDED = new Set(["frontend", "mobile", "node_modules", ".git", ".github"]);

const headers = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json",
};

function truncateText(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function getLMStudioEndpoint() {
  if (!LM_STUDIO_URL) throw new Error("LM_STUDIO_URL is not set");
  if (!LM_STUDIO_MODEL) throw new Error("LM_STUDIO_MODEL is not set");
  try {
    return new URL("/v1/chat/completions", LM_STUDIO_URL).toString();
  } catch {
    throw new Error(`LM_STUDIO_URL is invalid: ${LM_STUDIO_URL}`);
  }
}

function getServiceTestStatus() {
  const services = fs.readdirSync(".").filter((entry) => {
    if (EXCLUDED.has(entry)) return false;
    try {
      return fs.statSync(entry).isDirectory();
    } catch {
      return false;
    }
  });

  return services.map((service) => {
    const pkgPath = path.join(service, "package.json");
    if (!fs.existsSync(pkgPath)) return { service, hasTestScript: false, hasTestDir: false };
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const hasTestDir = fs.existsSync(path.join(service, "tests")) || fs.existsSync(path.join(service, "test"));
    return { service, hasTestScript: !!pkg.scripts?.test, hasTestDir };
  });
}

async function callLMStudio(systemPrompt, userPrompt) {
  const endpoint = getLMStudioEndpoint();
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LM_STUDIO_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `/no_think\n\n${userPrompt}` },
        ],
        temperature: 0.1,
        enable_thinking: false,
        max_tokens: 4096,
      }),
    });
  } catch (err) {
    throw new Error(`LM Studio fetch failed: ${err.message}`);
  }

  const rawBody = await response.text();
  const bodyPreview = truncateText(rawBody, 800);
  if (!response.ok) throw new Error(`LM Studio error ${response.status}: ${bodyPreview}`);

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`LM Studio returned invalid JSON: ${bodyPreview}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error(`LM Studio response missing choices[0].message.content: ${bodyPreview}`);
  }
  return content;
}

async function getComments() {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}/comments?per_page=100`,
    { headers }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to fetch comments: ${response.status} — ${err}`);
  }
  return response.json();
}

async function postComment(body) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`,
    { method: "POST", headers, body: JSON.stringify({ body }) }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to post comment: ${response.status} — ${err}`);
  }
}

async function main() {
  console.log(`\n🔄 Refining review for issue #${ISSUE_NUMBER}: "${ISSUE_TITLE}"`);

  // Extract user's feedback from their comment (strip the "refine" trigger word)
  const userFeedback = REFINE_COMMENT.replace(/^refine[:\s]*/i, "").trim();
  if (!userFeedback) {
    await postComment(
      `### ℹ️ No feedback provided\n\nUse \`refine: <your feedback>\` to tell the reviewer what to change. For example:\n\`refine: drop the testing suggestion, we already have tests\``
    );
    return;
  }

  console.log(`\n💬 User feedback: ${userFeedback}`);

  // Find the last reviewer comment with hidden data
  const comments = await getComments();
  const botComment = [...comments]
    .reverse()
    .find(
      (c) =>
        c.user.login === "github-actions[bot]" &&
        c.body.includes("<!-- ISSUE_REVIEW_DATA:")
    );

  let previousSuggestions = [];
  if (botComment) {
    const match = botComment.body.match(/<!-- ISSUE_REVIEW_DATA:(.*?) -->/s);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        previousSuggestions = data.suggestions || [];
      } catch {
        // ignore parse failures, proceed without previous suggestions
      }
    }
  }

  const serviceStatus = getServiceTestStatus();
  const serviceContext = serviceStatus
    .map((s) => `- ${s.service}: test script=${s.hasTestScript}, tests dir=${s.hasTestDir}`)
    .join("\n");

  const systemPrompt = `You are a senior developer helping a team write high-quality GitHub issues.
Your job is to review a GitHub issue and give explicit, highly specific, actionable feedback to improve its clarity.
You are refining a previous review based on feedback from the issue author.

IMPORTANT: Suggestions must be concrete and self-contained. Do not write vague suggestions like "add more context" or "clarify the goal". Instead, write exactly what should be added or changed, including specific field names, file names, function names, route paths, payload shapes, error messages, or step-by-step sequences as appropriate. A developer should be able to implement the issue without asking follow-up questions.

Evaluate the issue on:
- Clear problem statement or goal (name the exact service, endpoint, or component affected)
- Acceptance criteria or definition of done (list specific, verifiable conditions — e.g. "POST /auth/login returns 200 with a JWT when credentials are valid")
- Relevant context (what service or file is affected, why the change is needed, who it affects)
- For bugs: exact steps to reproduce with specific inputs, exact expected vs actual behavior including error messages or status codes
- For features: a concrete user story with specific inputs, outputs, and edge cases (e.g. "As a user, I POST {email, password} to /auth/register and receive a 201 with {id, email, token}")

TESTING RULE: If the issue involves creating a new backend service, or adding significant functionality to an existing service that has no test script or tests directory, you MUST include a suggestion to set up a testing framework (Jest + Supertest) and write tests covering the new functionality. Name specific test cases (e.g. "Test that POST /auth/register returns 400 when email is missing").

You will be given the current test status of each backend service. Use this to determine whether a testing suggestion is needed.

The user has provided feedback on the previous suggestions. Incorporate their feedback — remove suggestions they objected to, adjust ones they want changed, and keep suggestions they did not mention.

Respond ONLY with valid JSON. No markdown, no code fences.

JSON format:
{
  "quality": "good" | "needs_work",
  "summary": "One sentence assessment of the issue as written",
  "suggestions": ["suggestion 1", "suggestion 2"],
  "rewritten_title": "An improved title, or null if the title is fine"
}`;

  const userPrompt = `Issue Title: ${ISSUE_TITLE}

Issue Body:
${ISSUE_BODY || "No description provided."}

Current backend service test status:
${serviceContext || "No backend services found."}

Previous suggestions:
${previousSuggestions.length > 0 ? previousSuggestions.map((s, i) => `${i + 1}. ${s}`).join("\n") : "None"}

User feedback on previous suggestions:
${userFeedback}`;

  let review;
  try {
    const raw = await callLMStudio(systemPrompt, userPrompt);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    review = JSON.parse(cleaned);
  } catch (err) {
    console.error("❌ Failed to parse review response:", err.message);
    process.exit(1);
  }

  console.log(`\n📋 Quality: ${review.quality}`);

  const hiddenData = `<!-- ISSUE_REVIEW_DATA:${JSON.stringify({
    originalTitle: ISSUE_TITLE,
    originalBody: ISSUE_BODY || "",
    rewrittenTitle: review.rewritten_title || null,
    suggestions: review.suggestions,
  })} -->`;

  const checkboxes = review.suggestions.map((s) => `- [ ] ${s}`).join("\n");

  const refineHint = `> 💬 **Still not right?** Reply \`refine: <your feedback>\` or \`/refine: <your feedback>\` again to keep iterating.
> Example: \`refine: also remove the acceptance criteria suggestion, the issue already has that\``;

  let comment;
  if (review.quality === "good") {
    comment = `### ✅ Issue Review (Refined)

${review.summary}

This issue looks good! Select any suggestions to apply, or leave all unchecked and add a label to hand it off to the coder as-is.

**Suggestions:**
- [ ] Apply all
${checkboxes}

Check the boxes above then reply with **apply** or **/apply** to update the issue.

${refineHint}

${hiddenData}`;
  } else {
    comment = `### 🔍 Issue Review (Refined)

${review.summary}

**Select the suggestions you want to apply:**
- [ ] Apply all
${checkboxes}

Check the boxes above then reply with **apply** or **/apply** to update the issue, or add a \`bug\`, \`feature\`, or \`hotfix\` label to skip and hand it off to the coder as-is.

${refineHint}

${hiddenData}`;
  }

  await postComment(comment);
  console.log("\n✅ Refined review comment posted.");
}

main().catch((err) => {
  console.error("❌ Refine failed:", err);
  process.exit(1);
});
