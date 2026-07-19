---
id: implementation-review-gate
title: Implementation Review Gate
description: Uses a sequential implementation, testing, and review gate before delivery.
hints:
  - implement
  - development
  - review gate
  - test gate
default_mode: code
max_agents: 3
rounds:
  - name: implement
    type: chain
    roles: [implementer]
  - name: test
    type: chain
    roles: [test-runner]
  - name: review
    type: chain
    roles: [reviewer]
output_contract: findings
---

Run this playbook as a delivery gate. The implementer makes the scoped change, the test runner independently exercises it, and the reviewer inspects the resulting diff for defects and missing coverage.

The captain checks the evidence after every round. A failed or inconclusive gate must remain visible; the captain decides whether to re-dispatch, narrow the work, request user input, or deliver a clearly degraded result. Passing one gate does not waive the others.

The final report should list changed files, test commands and results, review findings, unresolved risks, and any corrective work still required.

Write the output in the user's language unless the task requires otherwise.
