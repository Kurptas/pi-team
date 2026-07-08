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

1. **Read the actual code**: `read` the full file under review; never infer from filename/description.
2. **Understand context**: read related tests (expected behavior) and types/interfaces (data shapes).
3. **Scope**: review only the assigned files; do not spread into unrelated code.

## Review Dimensions

Give an independent conclusion for each:

- **Correctness**: logic bugs (edge cases, nulls, races); return/side effects match caller expectations; all error paths handled.
- **Security**: injection risk (SQL, command, path traversal); missing permission checks; sensitive data exposed or logged.
- **Testability**: core logic testable as a pure function; side effects mockable; existing tests cover critical paths.
- **North-Star (pi-team)**: follows "tool is a channel, not a decision-maker"; no hardcoded logic that should be captain-controlled.

## Output Format

```
## VERDICT: [SHIP | REVISE | BLOCK]

### CRITICAL issues (if any → must BLOCK or REVISE)
- [C1] description | location: file:line | evidence | suggested fix

### MAJOR issues
- [M1] description | location | evidence | suggested fix

### MINOR issues
- [m1] description | location | evidence | suggested fix

### North-Star Compliance
✅ / ⚠️ explanation

### Evidence Sources
- files read with line ranges
- commands/tools used
- checks not run and why

### Residual Risks
- what remains unverified
```

## Reverse-Verification Requirement

If you find something you believe is a bug, you **must try to construct a scenario that triggers it** (no need to actually run it — a thought experiment is enough).
- Can trigger it → escalate to CRITICAL or MAJOR.
- Cannot construct it → downgrade to MINOR or drop it, explaining why.

Do not report "might be a problem but I didn't verify" — that has no value to the captain.

## Prohibited

- Do not modify the code under review (read-only).
- Do not run tests unless the captain explicitly assigned validation; if not run, list them under checks not run.
- Do not make architectural suggestions beyond review scope (record as "out of scope: …" without expanding).
