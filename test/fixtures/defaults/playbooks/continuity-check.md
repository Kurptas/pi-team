---
id: continuity-check
title: Session Continuity Check
description: Internal fixture that verifies within-run session reuse for a role invoked in two rounds.
hints:
  - internal verification
  - session continuity
  - cross-round reuse
default_mode: research
max_agents: 2
rounds:
  - name: register
    type: single
    roles: [continuity-recorder]
    goal: Record the verification nonce and produce a finding that the next round can cross-reference.
  - name: verify
    type: single
    roles: [continuity-recorder, continuity-auditor]
    goal: Recall the first-round nonce in the reused recorder session and independently audit session reuse.
output_contract: findings
---

This fixture validates within-run continuity only. In round one, the continuity recorder must output the exact nonce `CONTINUITY_CHK_8171`. In round two, the same role must inspect its prior session context and report whether that nonce is present. The continuity auditor independently checks the available session evidence.

A passing run requires the recorder to emit the nonce in round one, correctly recall it in round two, and the auditor to confirm reuse. Missing or ambiguous session evidence must be reported as a failure or uncertainty, not assumed success.

Write the output in the user's language unless the test requires otherwise.
