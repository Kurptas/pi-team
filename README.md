# pi-team

<p align="center">
  <a href="https://www.npmjs.com/package/pi-team"><img alt="npm" src="https://img.shields.io/npm/v/pi-team?style=flat-square&color=CB3837&logo=npm"></a>
  &nbsp;
  <a href="https://github.com/Kurptas/pi-team/releases"><img alt="Version" src="https://img.shields.io/github/v/release/Kurptas/pi-team?style=flat-square&color=32CD32"></a>
  &nbsp;
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-32CD32?style=flat-square"></a>
  &nbsp;
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.19-6C757D?style=flat-square&logo=node.js&logoColor=white">
</p>

**English** · [简体中文](./README.zh-CN.md)

> No single agent sees everything. The strongest model still reads with its own habits — what it overlooks, it overlooks every time you ask. A second model, built differently, notices what the first one walked right past.

**pi-team lets Pi assemble a small squad of AI agents and put them to work on a single task — different models covering each other's blind spots, each one doing what it does best.**

## Install

### Pi

**Recommended**

```bash
pi install npm:pi-team
```

**Pin a specific version**

```bash
pi install npm:pi-team@0.6.10
```

Then run `/reload` in Pi to activate it.

### Oh My Pi

pi-team also works as an extension for Oh My Pi. Use the `omp` command to install it.

```bash
omp install pi-team
```

**Pin a specific version**

```bash
omp install pi-team@0.6.10
```

Then restart or reload Oh My Pi.

## Try it in one line

The most direct way is the `/team` command, followed by your task. Or just tell Pi what you want in plain language:

```
/team Review this pull request with three independent models and reconcile what they find.
```

```
Assemble a team to build a bull case, a bear case, and a skeptic on $NVDA, then give me the balanced view.
```

That's it. Pi plans the roles, picks the models, dispatches the squad, and hands the findings back. You can watch it happen live, redirect a member that drifts, or stop the run whenever you like — you stay in command the whole way.

## When to use a team

Send a squad instead of a lone specialist and every member brings something the others lack: two models reviewing the same pull request flag different bugs, a careful reasoner weighs the evidence while a fast, cheap one races through files and sources. Code review is the obvious use — the real reach is wider, anywhere a single opinion leaves you uneasy:

- **Research a hard question** — several models dig from different angles, then one reconciles what they found. Cross-checked, not one model's first impression.
- **Financial and market analysis** — a bull, a bear, and a skeptic argue it out before you commit to a view.
- **Debug something ugly** — one reads the logs, another traces the code path, a third proposes the fix.
- **Weigh a real decision** — independent takes on the same trade-off, then a reasoned call instead of a coin flip.

## Why a squad beats a bigger prompt

- **Different models, different blind spots.** Independent agents disagree, and their disagreement is where bad assumptions surface. More copies of one model just repeat the same blind spots in unison.
- **The right model on the right job.** You put your strongest model on judgment and synthesis, and let lean, fast, inexpensive ones handle scanning and fact-gathering — so you're not paying frontier prices for grunt work.
- **A captain, not a vote.** Someone weighs the conflicting findings and makes the call. You get a reasoned synthesis, not an averaged-out answer that helps no one.

In practice: ask *one* model to review a pull request and it clears the change — thorough, but through its own habits. Run the same review as a team and a second model flags a race condition the first read straight past, while a third confirms the fix. Same task, one blind spot fewer.

## You stay in the loop

A team only helps if you can see it work and step in when it drifts. Background runs are push-first: Pi tells you when the team finishes or when a worker has gone two minutes without effective RADIO/ACK communication, instead of making you poll. Each episode alerts once; inspecting or steering an alerted worker opens one new observation window. Multiple worker debts are grouped, unfinished workers stay ahead of terminal ones in the TUI, and targeted or broadcast captain requests are actively delivered with queued/delivered/ACK state. Notifications never cancel or reroute workers for you—the judgment stays yours.

## Going further

pi-team ships with ready-made team templates — reviewer panels, a research roundtable, debug triage, and more — and you can write your own or let Pi design one on the spot for a task. Each role can be given its own operating guidance and confined to just the tools it needs, so a reviewer reads without ever touching your shell. It's flexible when you want it and sensible when you don't.

## License

MIT · [Issues](https://github.com/Kurptas/pi-team/issues)
