<div align="center">

# plan-bar

**A plan progress bar for Claude Code — live step tracking, ETA and per-step token accounting, rendered above the prompt.**

[![Version](https://img.shields.io/badge/version-0.4.1-8b5cf6?style=flat-square)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.287-6d28d9?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-c4b5fd?style=flat-square)](LICENSE)

</div>

```text
◐ Write the parser        ████████▓▓▓░░░░░░░░░░  2/5 · ~4m left · 1.24M tok ▴
```

## Overview

`plan-bar` is a Claude Code mod that turns the model's plan into a single-line status bar. While Claude works through a multi-step task, the bar shows:

| Field | Description |
| --- | --- |
| **Current step** | Label of the step currently `in_progress`. |
| **Progress** | Completed steps over total, with a bar that fills as steps finish. |
| **ETA** | Mean duration of finished steps × remaining steps. |
| **Tokens** | Total tokens consumed by the plan so far. |
| **Subagents** | Count of subagents currently running (`· 2 agents`), shown only while any are active. |

Hover or click the bar to expand a breakdown: per-step duration and token usage, the per-step average, the token total split into cache reads, uncached input and output, and — when the plan has spawned subagents — a compact list of up to four of them with status, tokens and elapsed time. Click again to collapse.

Each time a step finishes, a toast notification names it (`Done: <step>`). When every step is complete, a final toast reports it (`All N steps done.`) and the bar holds at 100% for 20 seconds, then clears. The mod renders nothing else — no side panes or extra bands.

## Installation

**Requirements:** Claude Code `2.1.287+` (terminal) or `2.1.286+` (desktop Code tab). Check with `claude --version`.

**Terminal (inside a session):**

```text
/plugin install plan-bar --marketplace djgp28/plan-bar
```

Confirm adding the marketplace and choose **user** scope so the mod loads in every session.

**Shell:**

```bash
claude plugin install plan-bar --marketplace djgp28/plan-bar
```

**Desktop app** (`/plugin` is unavailable): **+** next to the prompt box → **Plugins** → **Add marketplace** → `djgp28/plan-bar` → **Add plugin**.

Sessions opened before the install pick it up after `/reload-plugins`.

## Plan sources

`plan-bar` reads plan state from the model's own tool calls in the transcript, so mod load order does not matter. Supported sources:

1. `TodoWrite`: Claude Code's built-in to-do tool.
2. `mcp__plan-bar__plan`: a plan tool that `plan-bar` registers itself. Schema:

   ```ts
   { title?: string; steps: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
   ```

   `plan-bar` also tells the model to call it for any task with two or more steps.

## Metrics

**Duration.** A step's duration runs from the previous step's completion (or the plan's start) to its own completion. Steps already marked complete when the plan is first received are excluded from the average. The ETA appears once at least one step has been timed.

**Tokens.** Every model request issued while a step is `in_progress` is attributed to that step, including requests from subagents. Requests made while no step is in progress are reported as *between steps*. Totals include prompt-cache reads — usually the bulk of the count — and the expanded view breaks them out separately.

## Configuration

| Item | Location |
| --- | --- |
| Toggle (all sessions) | `/mods` pane, or `"plan-bar": false` in `~/.claude/mods/switches.json` |
| Error log | `~/.claude/mods-logs/plan-bar.log` (last 20 KB) |
| Persisted plan state | `~/.claude/mods-state/plan-bar-<session-id>.json` — restored on session resume |

## Project layout

```text
.claude-plugin/
  plugin.json          Plugin manifest
  marketplace.json     Single-plugin marketplace definition
hooks/
  hooks.json           Module entry point
  register.tsx         Bar rendering, plan ingestion, timing and token accounting
  register.test.tsx    Engine tests
types/
  index.d.ts           Shared types (BarPlan, BarStep, TokenUsage)
```

## License

[MIT](LICENSE) © djgp28
