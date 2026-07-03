---
id: manuals-index
title: Pi Team Manuals Index
role: both
auto-inject: false
version: 2026-07-04
description: Master index listing all manuals and SOP files, for humans to browse and for manual-loader.ts to scan.
manuals:
  - file: captain/01-captain-manual.md
    id: captain-manual
    role: captain
    auto-inject: true
  - file: worker/01-worker-playbook.md
    id: worker-playbook
    role: worker
    auto-inject: true
  - file: sop/code-review.md
    id: sop-code-review
    role: both
    auto-inject: false
    applies-to: [code-review]
  - file: sop/research.md
    id: sop-research
    role: worker
    auto-inject: false
    applies-to: [research]
---

# Pi Team Manuals — Master Index

This directory lists all pi-team role manuals and task SOPs.

## Directory Convention

| Path | Role | auto-inject | Description |
|------|------|-------------|-------------|
| `captain/01-captain-manual.md` | captain | ✅ | Captain code of conduct, Plan-Do-Check-Act |
| `worker/01-worker-playbook.md` | worker | ✅ | Base rules for all workers (incl. fanout/spawned) |
| `sop/code-review.md` | both | ❌ | Code review SOP, injected when the captain sets `sop: ["code-review"]` |
| `sop/research.md` | worker | ❌ | Research SOP, injected when the captain sets `sop: ["research"]` |

## Organization Rules

- `captain/` — manuals read only by the captain
- `worker/` — manuals read by all workers (incl. fanout workers, spawned workers)
- `sop/` — task-type operating procedures, selected by the captain via `sop: ["..."]` in a role definition
- `shared/` — not yet created; introduce it once there are 3+ `role: both` files

## Extension Conventions

- When SOP files exceed 10, create subdirectories under `sop/` by task domain (e.g. `sop/review/`, `sop/research/`)
- The `version` field uses `YYYY-MM-DD` format; `manual-loader.ts` warns when it is more than 90 days stale
- Body in English, frontmatter keys in English
- Body heading levels: `##` to `####`, no `#` (`#` is reserved for the file title)
- The always-on worker playbook targets ~400 tokens; each SOP targets ~600. The sum of injected content has a soft warning at 1100 tokens and a hard cap of 1600 tokens (enforced by manual-loader.ts), sized so the playbook plus one or two SOPs fit
