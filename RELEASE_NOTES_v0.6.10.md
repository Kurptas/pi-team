# pi-team v0.6.10

This release tightens captain-led teamwork around truthful evidence, explicit communication, and model-neutral routing.

## Highlights

- **Model-neutral built-ins** — the shipped role and playbook catalog now describes capabilities instead of naming preferred vendors or models. A release gate prevents model-specific recommendations, private resources, and non-English runtime prompts from leaking into public defaults.
- **Evidence-aware routing** — explicit captain choices still win, while real worker failures, hard provider errors, cached health evidence, strict policy, and lazy fallback now interact predictably without silent substitution.
- **Communication-based attention** — background attention is driven by missing RADIO/ACK communication rather than runtime, token growth, or tool activity. Each episode alerts once; captain observation or intervention opens one new window only for affected workers.
- **Queued → delivered → ACK request tracking** — captain requests carry stable IDs and per-worker ledgers, including broadcast delivery/ACK aggregation and terminal-without-ACK evidence.
- **Truthful active-first status** — attention, running, and pending workers appear before terminal workers in compact, expanded, and `team_status` views. Degraded workers use a distinct glyph/count, unacknowledged delivery is labeled `AWAITING_ACK`, and no recorded progress delta is reported factually as `live:no-delta`.
- **Less status noise** — default `team_status` output is a short captain control surface. Detailed telemetry remains in structured result data and appears in text only when it is relevant to an anomaly or control decision.
- **Stale notification suppression** — attention generated while the captain is busy is revalidated against the exact communication/request/cancel episode before delivery. Terminal, observed, superseded, or invalidated notifications are dropped without blocking monitor rearm.
- **Lifecycle hardening** — attention persistence is serialized and Windows-safe, unfinished queued notifications are released across shutdown/reload, and Pi 0.80-compatible `agent_start`/`agent_end` hooks avoid relying on newer-only lifecycle APIs.

## Validation

- 316 automated tests across 9 test files
- File-size, model-neutral default-resource, TypeScript, and whitespace gates pass
- Post-reload multi-model acceptance review confirmed attention concurrency, concise status behavior, Pi 0.80 compatibility, and clean source/deployment parity
- Pi and Oh My Pi deployed extension trees matched all 70 source files by SHA-256

## Upgrade

### Pi

```bash
pi install npm:pi-team@0.6.10
```

Then run `/reload`.

### Oh My Pi

```bash
omp install pi-team@0.6.10
```

Restart or reload Oh My Pi after installation.
