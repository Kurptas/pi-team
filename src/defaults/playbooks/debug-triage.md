---
id: debug-triage
title: Debug Triage
description: Uses a sequential log analysis, code-path tracing, and fix-validation workflow.
hints:
  - debug
  - bug
  - error
  - logs
  - root cause
default_mode: code
max_agents: 3
rounds:
  - name: analyze-logs
    type: chain
    roles: [log-reader]
  - name: trace-path
    type: chain
    roles: [code-path-tracer]
  - name: validate-fix
    type: chain
    roles: [fix-validator]
output_contract: findings
---

Run this playbook as a sequential triage. First establish what the logs actually show. Then trace that evidence through the relevant code path. Finally validate the proposed or existing fix against the original failure and relevant regressions.

After each round, the captain decides whether the evidence is sufficient to continue, whether the next role needs a narrower question, or whether human input is required. Do not allow an early hypothesis to become an assumed root cause.

The final report should state the observed failure, implicated files and call chain, root-cause confidence, repair path, validation commands and results, residual risks, and any missing evidence.

Write the output in the user's language unless the task requires otherwise.
