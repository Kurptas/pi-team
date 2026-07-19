---
id: multi-angle-review
title: Multi-Angle Review
description: Combines defect, adversarial-risk, and evidence-quality perspectives before synthesis.
hints:
  - multi-angle review
  - diverse review
  - adversarial review
  - evidence review
default_mode: review
max_agents: 4
rounds:
  - name: diverse-perspectives
    type: parallel
    roles: [reviewer, risk-skeptic, evidence-checker]
  - name: synthesize
    type: single
    roles: [synthesizer]
output_contract: findings
---

Use role diversity rather than predetermined model identities. The reviewer searches for concrete defects and regressions, the risk skeptic challenges assumptions and failure paths, and the evidence checker audits the support for important claims. The synthesizer then compares the independent findings, evidence quality, and disagreements.

The captain chooses suitable healthy workers for each role, watches for duplicated perspectives or missing angles, and decides whether a follow-up is necessary. Do not infer review quality from model labels, cost tiers, or worker count.

The final report should identify the reviewed scope, material findings, counterexamples, evidence gaps, disagreements, missing tests, repair priorities, confidence, and any degraded perspective.

Write the output in the user's language unless the task requires otherwise.
