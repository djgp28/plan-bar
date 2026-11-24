# Plan Bar for Claude Code and Codex CLI

See the active plan step and how many steps are complete while your coding agent works.

| Terminal | What appears |
| --- | --- |
| **Claude Code** | A bar above the prompt with steps, substeps, ETA and plan tokens. Click it to see per-step usage. |
| **Codex CLI** | A footer with step progress, model, reasoning level, context usage, and cumulative input and output tokens for the active thread. |

## Install in Claude Code

Requires Claude Code 2.1.287 or later in the terminal. Check your version with `claude --version`. From your shell, run:

```sh
claude plugin install plan-bar --marketplace djgp28/plan-bar --scope user
```

Inside Claude Code, you can also use `/plugin install plan-bar --marketplace djgp28/plan-bar` and choose **user** scope. Run `/reload-plugins` in an existing session. Check `/mods` for **plan-bar** and ask Claude to work through a multi-step task.

In the **desktop Code tab** (Claude Code 2.1.286 or later), use **+** next to the prompt box → **Plugins** → **Add marketplace** → `djgp28/plan-bar` → **Add plugin**.

## Install in Codex CLI

Tested with Codex CLI 0.171.0 on macOS. The installer uses a POSIX shell, Git and Python 3.8 or later. Check `codex --version` and `python3 --version`, then run these commands from a shell:

```sh
git clone https://github.com/djgp28/plan-bar.git
cd plan-bar
./install-codex.sh
```

If you already have a checkout, run `git pull --ff-only` and `./install-codex.sh` from that directory. Keep the checkout as the local marketplace source. To use a particular Codex executable, run `CODEX_BIN=/path/to/codex ./install-codex.sh`.

The installer registers the Codex marketplace, installs its plan hook, registers the `plan_bar` footer provider from the installed copy, and enables the experimental custom status line. Open a new terminal session with `codex` and finish setup:

1. Open `/hooks`, review the Plan Bar hook for `update_plan`, and trust it.
2. Open `/statusline`, select **Choose a status line provider**, then **Plan Bar**.
3. Ask Codex to use `update_plan` for a multi-step task and update it as it works. The step count advances on each completed step.

To verify the provider from the shell, run `codex mcp get plan_bar`. After updating the plugin, review its hook again if Codex prompts you.

## Codex CLI footer

```text
████░░░░░░ 2/5 Write tests  GPT-6.2 Sol · high  ctx 25% 32k/128k  140k in  4k out
```

Here, two of five steps are complete and **Write tests** is active. The current context uses 32k of 128k tokens. The thread has accumulated 140k input and 4k output tokens across requests.

Metrics appear as Codex supplies them. Progress appears when Codex calls its native `update_plan` tool. A prose proposal in Plan mode can precede the first tracked step. The completed bar stays visible for 20 seconds.

Plan Bar reads model and usage data from the active thread’s footer snapshot. It stores the step counts, current label and update time in `~/.local/state/codex-plan-bar/`.

To uninstall, select the built-in footer in `/statusline`, then run:

```sh
codex mcp remove plan_bar
codex plugin remove plan-bar@plan-bar-codex
codex plugin marketplace remove plan-bar-codex
```

## Claude Code features

`plan-bar` is a Claude Code mod that turns the model's plan into a single-line status bar. For example:

```text
◐ Write the parser › Tests  ██████████▓▓▓░░░░░░░░  2/5 ·3/4 · ~4m left · 1.24M tok ▴
```


| Field | Description |
| --- | --- |
| **Current step** | Label of the step currently `in_progress`, and its substep in progress (`Step › Substep`). |
| **Progress** | Completed steps over total, plus the current step's substeps (`·3/4`). The bar fills by fraction, so it moves as substeps finish. |
| **ETA** | Mean duration of finished steps × remaining steps; inside a step with substeps, the substeps' pace. |
| **Stale flag** | `⚠ no update 47m` in amber once the plan has gone 15 minutes without an update while Claude works. |
| **Tokens** | Total tokens consumed by the plan so far. |
| **Subagents** | Count of subagents currently running (`· 2 agents`), shown only while any are active. |

Hover or click the bar to expand a breakdown: per-step duration and token usage, the per-step average, the token total split into cache reads, uncached input and output, and — when the plan has spawned subagents — a compact list of up to four of them with status, tokens and elapsed time. Click again to collapse.

Each time a step finishes, a toast notification names it (`Done: <step>`). When every step is complete, a final toast reports it (`All N steps done.`) and the bar holds at 100% for 20 seconds, then clears. The mod renders nothing else — no side panes or extra bands.

### Plan sources

`plan-bar` reads plan state from the model's own tool calls in the transcript, so mod load order does not matter. Supported sources:

1. `TodoWrite`: Claude Code's built-in to-do tool.
2. `mcp__plan-bar__plan`: a plan tool that `plan-bar` registers itself. Schema:

   ```ts
   type Status = 'pending' | 'in_progress' | 'completed'
   { title?: string; steps: { text: string; status: Status; substeps?: { text: string; status: Status }[] }[] }
   ```

   `plan-bar` also tells the model to call it for any task with two or more steps, to keep each step to roughly 10 tool calls or 15 minutes, and to give longer steps substeps.
3. `mcp__helper-desk__plan`: helper-desk's plan tool, read from the transcript when that mod is on.

### Keeping the plan current

A long task used to leave the bar stuck on one step for hours. The model now gets short reminders after a tool result (the user never sees them):

| When | Reminder |
| --- | --- |
| A new request arrives while a plan is open | Carry the open plan on (send the updated list) or send a new one. |
| Two tool calls into a request with no plan | Make one. |
| Every 10 tool calls **or** 10 minutes without a plan update | The bar is stuck at N% on "step": send the full list now. Repeats until the plan is updated. |
| The step in progress has run 15+ minutes with no substeps | Give it substeps or split it. |

The plan tool's answer also reports overall progress and flags a long step with no substeps.

### Metrics

**Duration.** A step's duration runs from the previous step's completion (or the plan's start) to its own completion. Steps already marked complete when the plan is first received are excluded from the average. The ETA appears once at least one step has been timed.

**Tokens.** Every model request issued while a step is `in_progress` is attributed to that step, including requests from subagents. Requests made while no step is in progress are reported as *between steps*. Totals include prompt-cache reads — usually the bulk of the count — and the expanded view breaks them out separately.

### Configuration

| Item | Location |
| --- | --- |
| Toggle (all sessions) | `/mods` pane, or `"plan-bar": false` in `~/.claude/mods/switches.json` |
| Error log | `~/.claude/mods-logs/plan-bar.log` (last 20 KB) |
| Persisted plan state | `~/.claude/mods-state/plan-bar-<session-id>.json` — restored on session resume |

## License

[MIT](LICENSE) © djgp28
