#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { GITHUB_TOKEN, PR_NUMBER, REPO } = process.env;

const EXCLUDED = new Set(['frontend', 'mobile']);

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function findServices() {
  return fs.readdirSync('.').filter((entry) => {
    if (EXCLUDED.has(entry)) return false;
    const stat = fs.statSync(entry);
    if (!stat.isDirectory()) return false;
    const pkgPath = path.join(entry, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return !!pkg.scripts?.test;
  });
}

async function postComment(body) {
  await fetch(`https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({ body }),
  });
}

async function main() {
  const services = findServices();

  if (services.length === 0) {
    console.log('No testable services found.');
    return;
  }

  console.log(`\n🧪 Running tests for: ${services.join(', ')}`);

  const results = [];

  for (const service of services) {
    console.log(`\n── ${service} ──`);

    try {
      run('npm install', service);
      const output = run('npm test', service);
      console.log(output);
      results.push({ service, passed: true, output });
    } catch (err) {
      const output = err.stdout || err.message;
      console.error(output);
      results.push({ service, passed: false, output });
    }
  }

  const allPassed = results.every((r) => r.passed);
  const rows = results
    .map((r) => `| ${r.service} | ${r.passed ? '✅ Pass' : '❌ Fail'} |`)
    .join('\n');

  const failDetails = results
    .filter((r) => !r.passed)
    .map((r) => `<details>\n<summary>${r.service} output</summary>\n\n\`\`\`\n${r.output.slice(0, 3000)}\n\`\`\`\n</details>`)
    .join('\n');

  const comment = `### ${allPassed ? '✅' : '❌'} Agent Verify — Test Results

| Service | Result |
|---------|--------|
${rows}

${failDetails ? `\n**Failures:**\n${failDetails}` : ''}
${allPassed ? '\nAll tests passed. Ready for review.' : '\nTests failed. Review the output above before merging.'}`;

  await postComment(comment);
  console.log('\n✅ Results posted to PR.');

  if (!allPassed) process.exit(1);
}

main().catch((err) => {
  console.error('❌ Verify script failed:', err);
  process.exit(1);
});
