# Installing Plan Bar

Use the installation instructions for the agent the user wants to configure.

- **Codex CLI:** Follow [Install in Codex CLI](README.md#install-in-codex-cli). From this checkout, run `./install-codex.sh`. Verify with `codex mcp get plan_bar`. The user reviews the `update_plan` hook in `/hooks` and selects **Plan Bar** in `/statusline`.
- **Claude Code:** Follow [Install in Claude Code](README.md#install-in-claude-code). From the shell, run `claude plugin install plan-bar --marketplace djgp28/plan-bar --scope user`. In an existing session, use `/reload-plugins` and check `/mods`.
