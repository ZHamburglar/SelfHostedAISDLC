#!/usr/bin/env node

/**
 * Issue Polish Agent
 *
 * Triggered when an issue comment starts with "apply" or "/apply".
 * - Finds the most recent Issue Clarity Agent (or Refine Agent) review comment to extract suggestions
 * - Determines which suggestion checkboxes the author checked
 * - Calls LM Studio to rewrite the issue title and body applying only the selected suggestions
 * - Updates the issue in place with the improved content
 *
 * After polishing, add a bug, feature, or hotfix label to hand the issue off to the Issue Coder Agent.
 */

const {
  GITHUB_TOKEN,
  LM_STUDIO_URL,
  LM_STUDIO_MODEL,
  ISSUE_NUMBER,
  REPO,
} = process.env;

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
  if (!LM_STUDIO_URL) {
    throw new Error("LM_STUDIO_URL is not set");
  }
  if (!LM_STUDIO_MODEL) {
    throw new Error("LM_STUDIO_MODEL is not set");
  }
  try {
    return new URL("/v1/chat/completions", LM_STUDIO_URL).toString();
  } catch {
    throw new Error(`LM_STUDIO_URL is invalid: ${LM_STUDIO_URL}`);
  }
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

async function updateIssue(title, body) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}`,
    { method: "PATCH", headers, body: JSON.stringify({ title, body }) }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to update issue: ${response.status} — ${err}`);
  }
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
  if (!response.ok) {
    throw new Error(`LM Studio error ${response.status}: ${bodyPreview}`);
  }

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

function parseCheckedBoxes(commentBody, allSuggestions) {
  const applyAllChecked = /- \[x\] Apply all/i.test(commentBody);
  if (applyAllChecked) return allSuggestions;

  const checked = [];
  for (const suggestion of allSuggestions) {
    // Escape special regex characters in the suggestion text
    const escaped = suggestion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`- \\[x\\] ${escaped}`, "i").test(commentBody)) {
      checked.push(suggestion);
    }
  }
  return checked;
}

async function main() {
  console.log(`\n✏️  Applying selected suggestions to issue #${ISSUE_NUMBER}`);

  const comments = await getComments();

  // Find the last reviewer comment with hidden data
  const botComment = [...comments]
    .reverse()
    .find(
      (c) =>
        c.user.login === "github-actions[bot]" &&
        c.body.includes("<!-- ISSUE_REVIEW_DATA:")
    );

  if (!botComment) {
    console.error("❌ No reviewer comment found.");
    process.exit(1);
  }

  const match = botComment.body.match(/<!-- ISSUE_REVIEW_DATA:(.*?) -->/s);
  if (!match) {
    console.error("❌ Could not extract review data from comment.");
    process.exit(1);
  }

  let reviewData;
  try {
    reviewData = JSON.parse(match[1]);
  } catch (err) {
    console.error("❌ Failed to parse review data:", err.message);
    process.exit(1);
  }

  const { originalTitle, originalBody, rewrittenTitle, suggestions } = reviewData;

  // Parse which checkboxes are checked from the current comment body
  const selectedSuggestions = parseCheckedBoxes(botComment.body, suggestions);

  if (selectedSuggestions.length === 0) {
    await postComment(
      `### ℹ️ No suggestions selected\n\nCheck at least one box in the reviewer comment, then reply with **apply** again.`
    );
    console.log("No suggestions selected — nothing to apply.");
    return;
  }

  console.log(`\n📋 Applying ${selectedSuggestions.length} suggestion(s):`);
  selectedSuggestions.forEach((s) => console.log(`   - ${s}`));

  // Ask LM Studio to rewrite based only on selected suggestions
  const systemPrompt = `You are a senior developer rewriting a GitHub issue based on specific feedback.
Apply only the listed suggestions — do not add anything else.
Respond ONLY with valid JSON. No markdown, no code fences.

JSON format:
{
  "title": "improved title (or original if no title change needed)",
  "body": "fully rewritten issue body in markdown"
}`;

  const userPrompt = `Original Title: ${originalTitle}

Original Body:
${originalBody || "No description provided."}

Apply these suggestions:
${selectedSuggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}${
    rewrittenTitle ? `\n\nAlso use this improved title: ${rewrittenTitle}` : ""
  }`;

  let rewrite;
  try {
    const raw = await callLMStudio(systemPrompt, userPrompt);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    rewrite = JSON.parse(cleaned);
  } catch (err) {
    console.error("❌ Failed to parse rewrite response:", err.message);
    process.exit(1);
  }

  await updateIssue(rewrite.title, rewrite.body);

  await postComment(
    `### ✅ Issue Updated\n\n Applied ${selectedSuggestions.length} suggestion(s). Add a \`bug\`, \`feature\`, or \`hotfix\` label to hand it off to the agent.`
  );

  console.log("\n✅ Issue updated successfully.");
}

main().catch((err) => {
  console.error("❌ Apply failed:", err);
  process.exit(1);
});
