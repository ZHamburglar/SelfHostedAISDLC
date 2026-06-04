#!/usr/bin/env node

/**
 * Issue Agent
 * 
 * Triggered by GitHub Actions when an issue is opened/labeled.
 * - Reads the issue title, body, and labels
 * - Calls LM Studio to determine what code changes to make
 * - Applies the changes to a new branch
 * - Opens a PR using the correct template based on the issue label
 */

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── Config from environment ───────────────────────────────────────────────────
const {
  GITHUB_TOKEN,
  LM_STUDIO_URL,
  LM_STUDIO_MODEL,
  ISSUE_NUMBER,
  ISSUE_TITLE,
  ISSUE_BODY,
  ISSUE_LABELS,
  REPO,
  BASE_BRANCH,
} = process.env;

const labels = (ISSUE_LABELS || "").split(",").map((l) => l.trim().toLowerCase());
const MAX_REPO_STRUCTURE_FILES = 30;
const MAX_PLAN_PREVIEW = 800;
const MAX_REPAIR_INPUT = 12000;
const ALLOWED_ACTIONS = new Set(["create", "modify", "delete"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function runGit(args, options = {}) {
  console.log(`$ git ${args.join(" ")}`);
  return execFileSync("git", args, { stdio: "pipe", encoding: "utf8", ...options }).trim();
}

function detectPRTemplate() {
  if (labels.includes("bug"))     return { file: "bugfix.md",  label: "bug" };
  if (labels.includes("hotfix"))  return { file: "hotfix.md",  label: "hotfix" };
  if (labels.includes("feature")) return { file: "feature.md", label: "feature" };
  return { file: "feature.md", label: "feature" }; // default
}

function readTemplate(filename) {
  const templatePath = path.join(".github", "PULL_REQUEST_TEMPLATE", filename);
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, "utf8");
  }
  return "## Summary\n\n## Changes\n\n## Testing\n";
}

function truncateText(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function slugify(value, maxLength = 40) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return slug || "update";
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
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === opening) depth += 1;
    if (char === expectedClosing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
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

  if (text.startsWith("{") || text.startsWith("[")) {
    addCandidate(text);
  }

  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencedRegex.exec(text)) !== null) {
    addCandidate(match[1]);
  }

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const balanced = findBalancedJsonSnippet(text, i);
    if (balanced) addCandidate(balanced);
  }

  const firstObject = text.indexOf("{");
  const firstArray = text.indexOf("[");
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length > 0) {
    addCandidate(text.slice(Math.min(...starts)));
  }

  return candidates;
}

function parsePlanResponse(rawPlan) {
  const candidates = extractJsonCandidates(rawPlan);
  if (candidates.length === 0) {
    throw new Error("No JSON object or array could be extracted from model output");
  }

  const parseErrors = [];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      parseErrors.push(err.message);
    }
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
    pr_title: typeof plan.pr_title === "string" ? plan.pr_title.trim() : "",
    pr_body_notes: typeof plan.pr_body_notes === "string" ? plan.pr_body_notes.trim() : "",
    changes: plan.changes.map((change, index) => validateChange(change, index)),
  };
}

async function postIssueComment(commentBody) {
  if (!GITHUB_TOKEN || !REPO || !ISSUE_NUMBER) {
    console.warn("⚠️  Missing GitHub context; skipping issue comment.");
    return;
  }

  const response = await fetch(`https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + GITHUB_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ body: commentBody }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to comment on issue: ${response.status} — ${err}`);
  }
}

function normalizeResponseText(value) {
  if (typeof value === "string") {
    return value.trim() ? value : "";
  }
  if (!Array.isArray(value)) {
    return "";
  }

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

  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};
  const content =
    normalizeResponseText(message.content) ||
    normalizeResponseText(message.reasoning_content) ||
    normalizeResponseText(choice?.text);

  if (!content) {
    throw new Error(`LM Studio response missing usable text in choices[0]: ${bodyPreview}`);
  }
  return content;
}

async function getRepoStructure() {
  try {
    const files = [];
    const includeExt = new Set([".js", ".ts", ".json"]);
    const excludedDirs = new Set([".git", "node_modules"]);

    function walk(dir) {
      if (files.length >= MAX_REPO_STRUCTURE_FILES) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= MAX_REPO_STRUCTURE_FILES) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (excludedDirs.has(entry.name)) continue;
          walk(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!includeExt.has(path.extname(entry.name))) continue;
        files.push(path.relative(process.cwd(), fullPath));
      }
    }

    walk(process.cwd());
    return files.join("\n");
  } catch {
    return "Could not list files.";
  }
}

function getReadme() {
  const readmePath = path.join(process.cwd(), "README.md");
  try {
    if (fs.existsSync(readmePath)) {
      return fs.readFileSync(readmePath, "utf8");
    }
    return "";
  } catch {
    return "";
  }
}

function getAgentGuidelines() {
  const agentsPath = path.join(process.cwd(), ".github", "AGENTS.md");
  try {
    if (fs.existsSync(agentsPath)) {
      return fs.readFileSync(agentsPath, "utf8");
    }
    return "";
  } catch {
    return "";
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖 Issue Agent starting for issue #${ISSUE_NUMBER}: "${ISSUE_TITLE}"`);
  console.log(`   Labels: ${labels.join(", ")}`);

  // 1. Create a new branch
  const issueNumber = process.env.ISSUE_NUMBER;
  const runId = process.env.GITHUB_RUN_ID || Date.now();
  const branchName = `agent/issue-${issueNumber}-${runId}`;
  runGit(["config", "user.name", "Issue Agent"]);
  runGit(["config", "user.email", "agent@github-actions"]);
  runGit(["checkout", "-b", branchName]);
  console.log(`\n✅ Created branch: ${branchName}`);

  // 2. Get repo structure, README, and agent guidelines so the agent has context
  const repoStructure = truncateText(await getRepoStructure(), 4000);
  const readme = truncateText(getReadme(), 6000);
  const agentGuidelines = truncateText(getAgentGuidelines(), 4000);
  const issueBody = truncateText(ISSUE_BODY || "No description provided.", 6000);

  // 3. Ask LM Studio what changes to make
  console.log("\n🧠 Asking LM Studio for a plan...");
  const systemPrompt = `/no_think
  You are a senior JavaScript/Node.js developer working on a GitHub repository.
You will be given an issue and the repository file structure.
Your job is to:
1. Understand what needs to be done
2. Return a JSON object describing the exact file changes needed

ENDPOINT DOCUMENTATION RULE: If any of your changes create or modify API endpoints (REST routes, Express handlers, etc.), you MUST include a "modify" action for README.md in your changes array. Update the "## API Endpoints" section in the README with the new or changed endpoints. If the section does not exist, add it. Each endpoint entry should include: HTTP method, path, description, request body (if any), and response shape. Preserve all other existing README content exactly as-is.

IMPORTANT:
- Your output is parsed directly with JSON.parse().
- Return ONLY valid JSON. No markdown, no code fences, no prose, no explanation.
- Any text before or after the JSON will fail the workflow.
- Keep the response concise and focused. Prefer at most 5 file changes unless absolutely necessary.

JSON format:
{
  "summary": "Brief description of what you're doing",
  "changes": [
    {
      "action": "create" | "modify" | "delete",
      "path": "relative/file/path.js",
      "content": "full new file content as a string (for create/modify)",
      "reason": "why this change is needed"
    }
  ],
  "pr_title": "A concise PR title",
  "pr_body_notes": "Extra notes to add to the PR description"
}`;

  const userPrompt = `Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

Description:
${issueBody}

Labels: ${labels.join(", ")}

Agent Guidelines (you MUST follow all rules in this document):
${agentGuidelines || "No guidelines found."}

Repository file structure:
${repoStructure}

Current README.md:
${readme || "No README found."}

Keep the plan concise and include only essential file edits.
Return JSON only. No markdown, no code fences, and no explanation text.`;


  let rawPlan;
  try {
    rawPlan = await callLMStudio(systemPrompt, userPrompt);
  } catch (err) {
    console.error("❌ LM Studio request failed:", err.message);
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
  ],
  "pr_title": "string",
  "pr_body_notes": "string"
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
      process.exit(1);
    }
  }
  console.log(`\n📋 Plan: ${plan.summary || "No summary provided."}`);

  if (plan.changes.length === 0) {
    console.log("\nℹ️ Plan contained no file changes. Skipping commit and PR creation.");
    await postIssueComment("🤖 Issue Agent reviewed this issue but did not find actionable file changes to apply automatically.");
    return;
  }

  // 4. Apply the file changes
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
      // create or modify
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, change.content, "utf8");
      console.log(`   ✏️  ${change.action === "create" ? "Created" : "Modified"}: ${change.path}`);
    }
  }

  const changedFiles = runGit(["status", "--porcelain"]);
  if (!changedFiles) {
    console.log("\nℹ️ No effective file changes were produced. Skipping commit and PR creation.");
    await postIssueComment("🤖 Issue Agent generated a plan, but it resulted in no effective file changes, so no PR was created.");
    return;
  }

  // 5. Commit the changes
  runGit(["add", "-A"]);
  const commitSummary = plan.summary || "Automated issue resolution";
  const commitMsg = `fix: resolve issue #${ISSUE_NUMBER} — ${ISSUE_TITLE}\n\n${commitSummary}`;
  runGit(["commit", "-m", commitMsg]);
  console.log("\n✅ Changes committed");

  // 6. Push the branch
  execSync(`git push -u origin ${branchName}`, { stdio: "inherit" });
  console.log(`\n✅ Branch pushed: ${branchName}`);

  // 7. Build the PR body from the template + agent notes
  const { file: templateFile } = detectPRTemplate();
  const templateContent = readTemplate(templateFile);
  const prBody = `${templateContent}

---
> 🤖 *This PR was automatically generated by the Issue Agent for issue #${ISSUE_NUMBER}.*
>
> **Agent notes:** ${plan.pr_body_notes || "None"}
`;

  // 8. Create the PR via GitHub API
  console.log("\n🚀 Creating Pull Request...");
  const prPayload = {
    title: plan.pr_title || `[Agent] ${ISSUE_TITLE}`,
    body: prBody,
    head: branchName,
    base: BASE_BRANCH || "main",
    draft: false,
  };

  const prResponse = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(prPayload),
  });

  if (!prResponse.ok) {
    const err = await prResponse.text();

    if (prResponse.status === 403) {
      throw new Error(
        `Failed to create PR: 403. GitHub Actions is not allowed to create pull requests in this repository. ` +
        `Check repository Settings > Actions > General and enable:` +
        ` "Read and write permissions" and "Allow GitHub Actions to create and approve pull requests". ` +
        `Response: ${err}`
      );
    }

    throw new Error(`Failed to create PR: ${prResponse.status} — ${err}`);
  }

  const pr = await prResponse.json();

  // 9. Link the PR back to the issue with a comment
  await postIssueComment(`🤖 The Issue Agent has picked up this issue and created a PR: ${pr.html_url}`);

  console.log(`\n🎉 Done! PR created: ${pr.html_url}`);
}

main().catch((err) => {
  console.error("❌ Agent failed:", err);
  process.exit(1);
});
