---
id: code-review
title: Code Review
description: Runs three complementary code-review perspectives and synthesizes evidence for the captain.
hints:
  - review
  - code review
  - current changes
  - architecture risk
  - regression risk
default_mode: review
max_agents: 4
rounds:
  - name: parallel-review
    type: parallel
    roles: [architect-reviewer, risk-reviewer, reviewer]
  - name: synthesize
    type: single
    roles: [synthesizer]
output_contract: findings
---

Use a two-specialist-plus-one-generalist review structure. In the first round, the architecture reviewer checks boundaries and design direction, the engineering risk reviewer checks failure modes and operational safety, and the code reviewer checks concrete defects and regressions. In the second round, the synthesizer compares their evidence and disagreements.

The captain defines the review scope, monitors worker health and tool access, decides whether missing evidence requires another pass, and makes the final judgment. Worker conclusions are evidence, not authority.

The final report should identify affected files, material findings by severity, missing tests, disputed or weak evidence, residual risks, and a recommended repair order. Explicitly state when a review angle failed or produced no usable evidence.

Write the output in the user's language unless the task requires otherwise.
