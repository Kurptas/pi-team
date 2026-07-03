---
id: continuity-check
title: Session Continuity Check
description: Validates that the same role re-used across two rounds preserves session context. An internal quality verification tool, not a general-purpose playbook.
hints:
  - internal verification
  - session continuity
  - cross-round reuse
default_mode: research
max_agents: 2
rounds:
  - name: register
    type: single
    roles:
      - continuity-recorder
    goal: Record a verification nonce and produce a finding that the next round can cross-reference.
  - name: verify
    type: single
    roles:
      - continuity-recorder
      - continuity-auditor
    goal: Resume the continuity-recorder session, recall the nonce from round 1, and an auditor confirms that the session was reused.
output_contract: findings
---

# Session Continuity Check

## Purpose

This playbook is an internal product-quality verification tool. It validates that when the same `roleId` appears in two rounds of a single team run, the underlying Pi session directory is reused (rather than re-created from scratch), and the second-round worker can access the prior round's context.

**It does not validate cross-run continuity.** The session directory is scoped to a single `team` run and is deleted at run completion unless `PI_TEAM_KEEP_SESSIONS=1` is set.

## Roles

### continuity-recorder

Task: In round 1, record this exact nonce in your output: `CONTINUITY_CHK_8171`. Produce a short finding. In round 2, if you are re-invoked as the same role, read your own session history (your prior output) and confirm whether the nonce `CONTINUITY_CHK_8171` appears. Report whether session continuity is working.

### continuity-auditor

Task: In round 2, inspect the run state and session files to verify whether the continuity-recorder used the same session directory across both rounds. Report PASS if the session file exists and was reused; report FAIL otherwise.

## Acceptance

- `continuity-recorder` outputs the nonce `CONTINUITY_CHK_8171` in round 1.
- `continuity-recorder` confirms or denies the nonce in round 2.
- `continuity-auditor` independently confirms session reuse.
- The playbook is suitable as a focused test: a single `team(playbook="continuity-check")` call should suffice.
