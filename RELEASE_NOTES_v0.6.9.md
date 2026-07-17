# pi-team v0.6.9

This release makes captain-led teams more reliable, observable, and easier to supervise without babysitting them.

## Highlights

- **Push-first background runs** — normal runs now return `await_completion_push`. Pi follows up when the team finishes, while a runtime attention monitor reports only sustained recorded silence. It never cancels or reroutes workers automatically.
- **Evidence-aware model health** — synthetic timeout, rate-limit, and provider-error probes are advisory. Recent real worker outcomes carry more routing authority, while confirmed auth and model-not-found failures still block invalid choices.
- **Safer lazy fallback** — only selected primaries are probed eagerly; fallback models remain lazy and are tried after real execution failure. Cached hard failures are respected before fallback dispatch.
- **Model-compatible thinking** — requested thinking levels are mapped through model capability metadata instead of model-name rules. Probe sessions omit synthetic thinking defaults.
- **Actionable captain decisions** — role-specific `roleId=provider/model` overrides now reject malformed, unknown, or unconfigured choices immediately, accumulate across messages, and preserve strict/task-first timeout behavior.
- **Better status evidence** — `team_status` now exposes tool-call and tool-error totals, model-health evidence source, terminal delegation-lane state, and clearer liveness information.
- **Runtime hardening** — improved cancel target resolution, SOP id validation, worker-attempt accounting, fallback event aggregation, and current-run model-health persistence.

## Validation

- 281 automated tests across 8 test files
- TypeScript, file-size, and whitespace gates pass
- Post-reload runtime smoke confirmed: background dispatch returned `await_completion_push`, completed without polling, delivered a completion follow-up, and closed its delegation lane successfully

## Upgrade

### Pi

```bash
pi install npm:pi-team@0.6.9
```

Then run `/reload`.

### Oh My Pi

```bash
omp install pi-team@0.6.9
```

Restart or reload Oh My Pi after installation.
