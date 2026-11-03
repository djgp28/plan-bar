# plan-bar

A Claude Code mod that puts one purple progress bar above the prompt while Claude works through a plan:

```
◐ Write the parser        ████████▓▓▓░░░░░░░░░░  2/5 · ~4m left · 1.24M tok ▴
```

- **The step in progress**, by name
- **Steps done out of total**, with a purple bar that fills as steps finish
- **Time left**: the average time per finished step × the steps still to do
- **Tokens used** by the plan so far

Hover over the bar, or click it, to see every step with how long it took and how many tokens it used, the average per step, and the token total split into cache reads, new input and output. Click again to close. Nothing else is drawn: no side pane, no subagent cards.

Once every step is done, the bar stays at 100% for 20 seconds and then goes away.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install plan-bar --marketplace djgp28/plan-bar
```

Answer `y` to add the marketplace, then pick the user scope so it loads in every chat.

From a shell:

```
claude plugin install plan-bar --marketplace djgp28/plan-bar
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `djgp28/plan-bar`, then **Add plugin**.

Chats that were already open before the install load it after `/reload-plugins`. It needs Claude Code 2.1.287 or newer (2.1.286 in the desktop Code tab).

## Where the plan comes from

plan-bar reads the plan from Claude's own calls:

- `mcp__helper-desk__plan`, from the [helper-desk](https://www.benai.co) mod, when that mod is installed
- `TodoWrite`

Where helper-desk is not installed or is switched off, plan-bar adds its own `mcp__plan-bar__plan` tool (same input: an optional `title` and `steps` of `{ text, status }`) and asks Claude to use it for any task with two or more steps.

If you use helper-desk too, hide its pane and bar in `/mods` (Helper Desk → **Hidden**) and leave it **On**, so its plan tool keeps feeding plan-bar.

## How the numbers are counted

- **Time**: each finished step runs from the finish before it (or the plan's start). Steps already done when the plan first arrives are left out of the average. The estimate shows once one step has finished.
- **Tokens**: every model request made while a step is in progress counts toward that step, its subagents' requests included. Requests while no step is in progress count as "between steps". Totals include prompt-cache reads, which are usually most of them; the details line splits them out.

## Off switch and logs

Turn it off in every chat from the `/mods` pane, or with `"plan-bar": false` in `~/.claude/mods/switches.json`. Errors go to `~/.claude/mods-logs/plan-bar.log`. The plan of each chat is kept in `~/.claude/mods-state/plan-bar-<session id>.json` so a resumed chat picks it up again.

## License

MIT
