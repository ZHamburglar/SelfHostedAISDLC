#!/usr/bin/env node

/**
 * PR Fix Agent
 *
 * Triggered by a /fix comment on an agent-created PR.
 * - Fetches the PR branch, current diff, and all prior /fix comments
 * - Calls LM Studio with that context to produce a correction plan
 * - Applies changes, commits, and pushes to the existing PR branch
 * - Posts a summary comment on the PR
 */

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  GITHUB_TOKEN,
  LM_STUDIO_URL,
  LM_STUDIO_MODEL,
  PR_NUMBER,
  FIX_COMMENT,
  REPO,
} = process.env;

const MAX_DIFF_LENGTH = 8000;
const MAX_COMMENTS_LENGTH = 4000;
const MAX_PR_BODY_LENGTH = 3000;
const MAX_PLAN_PREVIEW = 800;
const MAX_REPAIR_INPUT = 12000;
const ALLOWED_ACTIONS = new Set(["create", "modify", "delete"]);

const githubHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function runGit(args, options = {}) {
  console.log(`$ git ${args.join(" ")}`);
  return execFileSync("git", args, { stdio: "pipe", encoding: "utf8", ...options }).trim();
}

function truncateText(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function resolvePathInRepo(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("path must be a non-empty string");
  }
  const cleanedPath = rawPath.trim().replace(/\\/g, "/");
  if (path.isAbsolute(cleanedPath)) {
    throw new Error(`path must be relative: "${rawPath}"`);
  }
  const normalizedPath = path.normalize(cleanedPath);
  if (normalizedPath.startsWith("..") || path.isAbsolute(normalizedPath)) {
    throw new Error(`path escapes repository root: "${rawPath}"`);
  }
  const repoRoot = process.cwd();
  const fullPath = path.resolve(repoRoot, normalizedPath);
  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`path resolves outside repository root: "${rawPath}"`);
  }
  return { normalizedPath, fullPath };
}

function findBalancedJsonSnippet(text, startIndex) {
  const opening = text[startIndex];
  if (opening !== "{" && opening !== "[") return null;
  const expectedClosing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (char === "\\") { escaped = true; }
      else if (char === "\"") { inString = false; }
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === opening) depth += 1;
    if (char === expectedClosing) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

function extractJsonCandidates(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];

  const candidates = [];
  const seen = new Set();

  function addCandidate(candidate) {
    const value = String(candidate || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  }

  if (text.startsWith("{") || text.startsWith("[")) addCandidate(text);

  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencedRegex.exec(text)) !== null) addCandidate(match[1]);

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const balanced = findBalancedJsonSnippet(text, i);
    if (balanced) addCandidate(balanced);
  }

  const firstObject = text.indexOf("{");
  const firstArray = text.indexOf("[");
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length > 0) addCandidate(text.slice(Math.min(...starts)));

  return candidates;
}

function parsePlanResponse(rawPlan) {
  const candidates = extractJsonCandidates(rawPlan);
  if (candidates.length === 0) {
    throw new Error("No JSON object or array could be extracted from model output");
  }
  const parseErrors = [];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (err) { parseErrors.push(err.message); }
  }
  const lastError = parseErrors[parseErrors.length - 1] || "unknown parse error";
  throw new Error(`Unable to parse plan JSON from ${candidates.length} candidate(s): ${lastError}`);
}

function validateChange(change, index) {
  const where = `changes[${index}]`;
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw new Error(`${where} must be an object`);
  }
  const action = typeof change.action === "string" ? change.action.trim().toLowerCase() : "";
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`${where}.action must be one of: create, modify, delete`);
  }
  const { normalizedPath, fullPath } = resolvePathInRepo(change.path);
  const nextChange = {
    action,
    path: normalizedPath,
    fullPath,
    reason: typeof change.reason === "string" ? change.reason : "",
  };
  if (action === "create" || action === "modify") {
    if (typeof change.content !== "string") {
      throw new Error(`${where}.content must be a string for action "${action}"`);
    }
    nextChange.content = change.content;
  }
  return nextChange;
}

function validatePlanShape(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Plan must be a JSON object");
  }
  if (!Array.isArray(plan.changes)) {
    throw new Error('Plan must include a "changes" array');
  }
  return {
    summary: typeof plan.summary === "string" ? plan.summary.trim() : "",
    changes: plan.changes.map((change, index) => validateChange(change, index)),
  };
}

function normalizeResponseText(value) {
  if (typeof value === "string") return value.trim() ? value : "";
  if (!Array.isArray(value)) return "";
  const text = value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("");
  return text.trim() ? text : "";
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
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`LM Studio returned invalid JSON: ${bodyPreview}`); }

  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};
  const content =
    normalizeResponseText(message.content) ||
    normalizeResponseText(message.reasoning_content) ||
    normalizeResponseText(choice?.text);

  if (!content) throw new Error(`LM Studio response missing usable text: ${bodyPreview}`);
  return content;
}

// ── GitHub API ────────────────────────────────────────────────────────────────

async function getPR() {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}`,
    { headers: githubHeaders }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to fetch PR: ${response.status} — ${err}`);
  }
  return response.json();
}

async function getPRComments() {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`,
    { headers: githubHeaders }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to fetch PR comments: ${response.status} — ${err}`);
  }
  return response.json();
}

async function postPRComment(body) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`,
    {
      method: "POST",
      headers: githubHeaders,
      body: JSON.stringify({ body }),
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to post PR comment: ${response.status} — ${err}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔧 PR Fix Agent starting for PR #${PR_NUMBER}`);
  console.log(`   Feedback: ${truncateText(FIX_COMMENT, 200)}`);

  // 1. Fetch PR details
  const pr = await getPR();
  const branchName = pr.head.ref;
  const baseBranch = pr.base.ref;
  console.log(`   Branch: ${branchName} → ${baseBranch}`);

  // 2. Checkout the PR branch
  runGit(["config", "user.name", "PR Fix Agent"]);
  runGit(["config", "user.email", "agent@github-actions"]);
  runGit(["fetch", "origin", branchName]);
  runGit(["checkout", branchName]);
  console.log(`\n✅ Checked out branch: ${branchName}`);

  // 3. Get current diff vs base for context
  const diff = truncateText(
    runGit(["diff", `origin/${baseBranch}...HEAD`]),
    MAX_DIFF_LENGTH
  );

  // 4. Fetch prior /fix comments for full feedback history
  const allComments = await getPRComments();
  const priorFeedback = allComments
    .filter((c) => c.body.trimStart().startsWith("/fix"))
    .map((c) => `- ${c.body.trim()}`)
    .join("\n");

  // 5. Build and send the prompt
  console.log("\n🧠 Asking LM Studio for a fix plan...");

  const systemPrompt = `/no_think
You are a senior JavaScript/Node.js developer iterating on code changes based on PR review feedback.
You are given the current state of a PR as a git diff and reviewer feedback.
Your job is to return a JSON object describing the exact file changes needed to address the feedback.

IMPORTANT:
- Your output is parsed directly with JSON.parse().
- Return ONLY valid JSON. No markdown, no code fences, no prose, no explanation.
- Keep the response concise. Prefer at most 5 file changes unless absolutely necessary.
- For "modify" actions, always return the COMPLETE new file content, not just the changed lines.

JSON format:
{
  "summary": "Brief description of what you changed to address the feedback",
  "changes": [
    {
      "action": "create" | "modify" | "delete",
      "path": "relative/file/path.js",
      "content": "full new file content as a string (for create/modify)",
      "reason": "why this change addresses the feedback"
    }
  ]
}`;

  const userPrompt = `PR #${PR_NUMBER}: ${pr.title}

PR Description:
${truncateText(pr.body || "No description.", MAX_PR_BODY_LENGTH)}

Current changes in this PR (git diff vs ${baseBranch}):
${diff || "No diff available."}

Prior feedback on this PR:
${priorFeedback || "None."}

Feedback to address now:
${FIX_COMMENT}

Return JSON only. Address all points in the feedback.`;

  let rawPlan;
  try {
    rawPlan = await callLMStudio(systemPrompt, userPrompt);
  } catch (err) {
    console.error("❌ LM Studio request failed:", err.message);
    await postPRComment(`❌ Fix agent failed to reach LM Studio: ${err.message}`);
    process.exit(1);
  }

  let plan;
  try {
    plan = validatePlanShape(parsePlanResponse(rawPlan));
  } catch (err) {
    console.error("❌ Failed to parse/validate plan JSON:", err.message);
    console.error(`Raw model output preview: ${truncateText(rawPlan, MAX_PLAN_PREVIEW)}`);
    console.log("🔧 Attempting one repair pass...");

    const repairSystemPrompt = `You convert model output into strict JSON.
Return only valid JSON that exactly matches this schema and nothing else:
{
  "summary": "string",
  "changes": [
    {
      "action": "create" | "modify" | "delete",
      "path": "relative/file/path",
      "content": "string required for create/modify",
      "reason": "string"
    }
  ]
}
Rules:
- Do not include markdown or code fences.
- Do not include explanations.
- Preserve intent from the original response.`;
    const repairUserPrompt = `Convert this response to valid JSON only:\n\n${truncateText(rawPlan, MAX_REPAIR_INPUT)}`;

    try {
      const repairedPlan = await callLMStudio(repairSystemPrompt, repairUserPrompt);
      plan = validatePlanShape(parsePlanResponse(repairedPlan));
      console.log("✅ Repair pass succeeded.");
    } catch (repairErr) {
      console.error("❌ Repair attempt failed:", repairErr.message);
      await postPRComment(`❌ Fix agent could not produce a valid plan. Please rephrase your feedback and try again.`);
      process.exit(1);
    }
  }

  console.log(`\n📋 Plan: ${plan.summary || "No summary provided."}`);

  if (plan.changes.length === 0) {
    await postPRComment("🤖 The fix agent reviewed your feedback but found no file changes needed.");
    return;
  }

  // 6. Apply changes
  console.log("\n📝 Applying changes...");
  for (const change of plan.changes) {
    const { fullPath } = change;
    const dir = path.dirname(fullPath);

    if (change.action === "delete") {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log(`   🗑  Deleted: ${change.path}`);
      } else {
        console.log(`   ℹ️  Skip delete (not found): ${change.path}`);
      }
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, change.content, "utf8");
      console.log(`   ✏️  ${change.action === "create" ? "Created" : "Modified"}: ${change.path}`);
    }
  }

  const changedFiles = runGit(["status", "--porcelain"]);
  if (!changedFiles) {
    await postPRComment("🤖 The fix agent applied a plan but it resulted in no effective file changes.");
    return;
  }

  // 7. Commit and push
  runGit(["add", "-A"]);
  const commitMsg = `fix: address PR feedback\n\n${plan.summary}`;
  runGit(["commit", "-m", commitMsg]);
  execSync(`git push origin ${branchName}`, { stdio: "inherit" });
  console.log(`\n✅ Changes pushed to ${branchName}`);

  // 8. Post confirmation comment
  const changeList = plan.changes
    .map((c) => `- \`${c.action}\` \`${c.path}\` — ${c.reason}`)
    .join("\n");

  await postPRComment(`🤖 **Fix applied!**

${plan.summary}

**Changes made:**
${changeList}

---
Leave another \`/fix\` comment to request further changes.`);

  console.log(`\n🎉 Done!`);
}

main().catch((err) => {
  console.error("❌ PR Fix Agent failed:", err);
  process.exit(1);
});
