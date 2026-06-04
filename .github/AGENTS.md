# Agent Guidelines

This document defines the standards, architecture rules, and boundaries that all agents (automated or AI-assisted) **must** follow when making changes to this repository. Read this in full before making any changes.

---

## Architecture

This project follows a **Microservices** architecture.

- Each service is **independently deployable** and owns its own data
- Services communicate via **APIs or message queues** — never by importing directly from another service's internals
- Each service lives in its own directory with its own `package.json`
- Shared utilities go in a dedicated `shared/` or `packages/` directory — do not duplicate logic across services
- Do not add cross-service dependencies without explicit approval in the issue

### Folder Structure Convention

```
/services
  /service-name
    /src
      /controllers    # Request handlers (MVC-style within each service)
      /routes         # Express route definitions
      /models         # Data models / schemas
      /utils          # Helper functions specific to this service
    /tests
    package.json
    .env.example
/shared               # Shared utilities used across services
/config               # Global config (do NOT modify without approval)
```

---

## Code Style

### Quotes
- Always use **single quotes** `'` over double quotes `"`
- Exception: JSON files require double quotes — that is fine

```js
// ✅ Correct
const name = 'John';
import express from 'express';

// ❌ Wrong
const name = "John";
```

### Semicolons
- **Always** end statements with a semicolon

```js
// ✅ Correct
const value = 42;
doSomething();

// ❌ Wrong
const value = 42
doSomething()
```

### Async / Await
- Always prefer `async/await` over `.then()` / `.catch()` chains
- Always wrap `await` calls in `try/catch` for error handling

```js
// ✅ Correct
async function fetchData(id) {
  try {
    const result = await db.find(id);
    return result;
  } catch (err) {
    throw new Error(`Failed to fetch data: ${err.message}`);
  }
}

// ❌ Wrong
function fetchData(id) {
  return db.find(id)
    .then(result => result)
    .catch(err => { throw err; });
}
```

### Functional over OOP
- Prefer **functions and modules** over classes
- Use pure functions where possible — avoid side effects
- Do not use `class` unless integrating with a library that requires it

```js
// ✅ Correct
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

// ❌ Wrong
class Cart {
  calculateTotal() { ... }
}
```

### General Rules
- Use `const` by default; only use `let` when reassignment is necessary — never use `var`
- Use descriptive variable names — avoid single-letter names outside of loop counters
- Keep functions small and single-purpose — if a function does more than one thing, split it
- Use early returns to avoid deeply nested conditionals

---

## Testing

- **Every new function or endpoint must have a corresponding test**
- Tests live in the `/tests` directory within each service
- Use the existing test framework already configured in the service — do not introduce a new one
- Test file naming convention: `filename.test.js`
- Tests must cover: happy path, edge cases, and error handling

```
/services/user-service/tests
  user.controller.test.js
  user.model.test.js
```

---

## What the Agent Must NOT Do

These are hard rules. Do not violate them under any circumstances.

| Rule | Detail |
|---|---|
| 🚫 Do not delete files | Never delete any file. If a file needs to be removed, leave a comment in the PR explaining why and let a human decide |
| 🚫 Do not install new npm packages | Do not add new entries to `dependencies` or `devDependencies` in any `package.json`. Use only what is already installed |
| 🚫 Do not modify config files | Files such as `.env`, `.env.example`, `eslint.config.js`, `.prettierrc`, `docker-compose.yml`, and anything in `/config` are off-limits |
| 🚫 Do not modify other services | Only touch the service(s) directly relevant to the issue. Do not make changes in unrelated service directories |
| 🚫 Do not commit secrets | Never write API keys, tokens, passwords, or credentials into any file |

---

## What the Agent Should Always Do

- Read the issue title, body, and labels carefully before making any changes
- Scope changes to only what is necessary to resolve the issue
- Follow the folder structure convention above when creating new files
- Run ESLint and Prettier on any files it creates or modifies
- Write tests alongside any new code
- Use clear, descriptive commit messages in the format: `type: short description (#issue-number)`
  - Types: `fix`, `feat`, `refactor`, `test`, `docs`

---

## Commit Message Format

```
feat: add user authentication endpoint (#42)
fix: handle null response from payment service (#87)
refactor: simplify order calculation logic (#103)
test: add missing tests for notification service (#91)
docs: update README for deployment steps (#55)
```

---

## When in Doubt

If the issue is ambiguous, the scope is unclear, or a change would require violating any rule above — **do not guess**. Instead:

1. Post a comment on the issue explaining what is unclear
2. List the options or tradeoffs
3. Wait for human input before proceeding
