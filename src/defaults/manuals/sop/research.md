---
id: research
title: Research SOP
role: worker
auto-inject: false
applies-to: [research]
version: 2026-07-04
description: Operating procedure for research workers. Search first, then read closely, do not duplicate other workers' angles, output structured findings.
---

# Research SOP

## Before Researching

1. **Clarify your angle**: your task specifies an angle (e.g. "from a performance angle", "from a security angle"). **Research only your angle**; do not cover other workers' scope.
2. **Search before reading closely**: use search tools to quickly locate relevant sources, then read the 2-3 most relevant sources closely — do not skim 10.
3. **Record sources**: every finding must cite a source (URL, file path, line number); a finding with no source is not trustworthy.

## Research Flow

### Step 1: Locate (within 5 minutes)
- Use `web_search` or `bash grep` to quickly find relevant resources.
- List candidate sources, ranked by relevance.
- Pick 2-3 to read closely, skip the rest.

### Step 2: Read Closely and Extract
- Read the full content, do not skip.
- Extract facts directly relevant to your research angle.
- Distinguish **facts** (source-backed) from **inferences** (your interpretation).

### Step 3: Cross-Verify
- For key findings, try to find a second source to corroborate.
- If two sources conflict, report both — do not adjudicate yourself.

## Output Format

```
## Research Angle
[your research angle]

## Key Findings
1. [finding] — source: [URL/file:line]
2. [finding] — source: [URL/file:line]

## Inferences (grounded but not direct facts)
- [inference] — basis: [finding number]

## Conflicts
- [if any] Source A says X, Source B says Y, cannot adjudicate — captain decides.

## Uncovered Questions
- [questions this research did not answer, for the captain to decide whether to follow up]

## Source List
- [1] URL or file path
```

## Collaboration With Other Workers

- **Do not duplicate**: if you encounter content in another worker's angle during research, record it under "Uncovered Questions" — do not cross the boundary and expand on it.
- **Do not synthesize**: do not combine all workers' findings into a conclusion — synthesis is the captain's responsibility.
- **Report only your angle**: structured, complete, sourced.

## Prohibited

- No unsourced assertions ("it is generally believed…", "typically…" do not count as sources).
- No decisions on the captain's behalf ("recommend option A" — that is the captain's call).
- No analysis beyond your research angle.
