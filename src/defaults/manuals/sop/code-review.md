---
id: code-review
title: Code Review SOP
role: worker
auto-inject: false
applies-to: [code-review]
version: 2026-07-04
description: Operating procedure for code-review workers. Which files to read, which dimensions to review, what format to output.
---

# Code Review SOP

## Before Reviewing

1. **Read the actual code, do not guess**: use `read` to read the full file under review; do not infer content from the filename or description.
2. **Understand the context**: read related test files to learn expected behavior; read types.ts / interface definitions to learn data shapes.
3. **Scope the review**: only review the files and functionality the captain assigned; do not spread into unrelated code.

## Review Dimensions

Check each dimension below and give an independent conclusion for each:

### Correctness
- Are there logic bugs (edge cases, null values, races)?
- Do return values and side effects match the caller's expectations?
- Are all error paths handled?

### Security
- Any injection risk (SQL, command, path traversal)?
- Any missing permission checks?
- Is sensitive data improperly exposed or logged?

### Testability
- Is the core logic a pure function that can be tested independently?
- Can side effects be mocked or isolated?
- Do existing tests cover the critical paths?

### North-Star Compliance (pi-team specific)
- Does it follow the "the tool is a channel, it does not decide for the captain" principle?
- Is there hardcoded decision logic that should be under the captain's control?

## Output Format

```
## VERDICT: [SHIP | REVISE | BLOCK]

### CRITICAL issues (if any → must BLOCK or REVISE)
- [C1] description | location: file:line | suggested fix

### MAJOR issues
- [M1] description | location | suggested fix

### MINOR issues
- [m1] description | location | suggested fix

### North-Star Compliance
✅ / ⚠️ explanation

### Evidence Sources
- which files were read, line ranges
```

## Reverse-Verification Requirement

If you find something you believe is a bug, you **must try to construct a scenario that triggers it** (no need to actually run it — a thought experiment is enough).
- Can trigger it → escalate to CRITICAL or MAJOR.
- Cannot construct it → downgrade to MINOR or drop it, explaining why.

Do not report "might be a problem but I didn't verify" — that has no value to the captain.

## Prohibited

- Do not modify the code under review (read-only).
- Do not run tests (report test coverage, do not execute).
- Do not make architectural suggestions beyond review scope (record as "out of scope: …" without expanding).
