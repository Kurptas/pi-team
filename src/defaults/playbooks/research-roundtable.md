---
id: research-roundtable
title: Research Roundtable
description: Organizes source discovery, supportive and skeptical perspectives, evidence checking, and synthesis.
hints:
  - research
  - roundtable
  - report
  - strategy
  - decision
default_mode: research
max_agents: 4
rounds:
  - name: collect
    type: parallel
    roles: [scout, perspective-advocate, risk-skeptic, evidence-checker]
  - name: synthesize
    type: single
    roles: [synthesizer]
output_contract: findings
---

Use four distinct research perspectives. The scout maps the relevant sources and context, the perspective advocate develops the strongest supportable case, the risk skeptic tests counterarguments and constraints, and the evidence checker verifies important claims. The synthesizer integrates their evidence without erasing disagreement.

The captain defines the research question and time boundaries, monitors source access and worker quality, identifies missing perspectives, and decides whether more research is required. The captain owns the final recommendation.

The final report should state the task objective, verified facts, supportive and opposing arguments, source limitations, key disagreements, recommended actions, confidence, and residual uncertainty.

Write the output in the user's language unless the task requires otherwise.
