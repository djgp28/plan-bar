#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cli=${CODEX_BIN:-codex}
"$cli" plugin marketplace add "$repo"
installed=$("$cli" plugin add plan-bar@plan-bar-codex --json)
plugin_dir=$(printf '%s' "$installed" | python3 -c 'import json,sys; print(json.load(sys.stdin)["installedPath"])')
"$cli" mcp add plan_bar -- python3 -u "$plugin_dir/statusline.py"
"$cli" features enable tui_extensions_statusline
printf '%s\n' 'Restart Codex. In /hooks, review the Plan Bar update_plan hook. In /statusline, choose the Plan Bar provider.'
