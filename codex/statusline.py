"""A Codex statusline provider using newline-delimited MCP over stdio."""

import json
import sys
import tempfile
import time
from hashlib import sha256
from pathlib import Path


URI = "ui://plan-bar/footer"
TOOL = {
    "name": "statusline",
    "title": "Plan Bar",
    "description": "Show plan progress and thread usage in the Codex footer.",
    "inputSchema": {"type": "object", "properties": {}},
    "_meta": {
        "openai/ui": {"entrypoints": [{"type": "statusline", "resourceUri": URI}]}
    },
}


def plan_file(thread_id):
    # Thread IDs are opaque. Hash them before using them as filenames.
    key = sha256(thread_id.encode()).hexdigest()
    return Path.home() / ".local" / "state" / "codex-plan-bar" / (key + ".json")


def record(event):
    if event.get("tool_name") != "update_plan":
        return
    thread_id = event.get("agent_id") or event.get("session_id")
    steps = event.get("tool_input", {}).get("plan")
    if not thread_id or not isinstance(steps, list):
        return
    if not all(isinstance(s, dict) and isinstance(s.get("step"), str)
               and s.get("status") in ("completed", "pending", "in_progress") for s in steps):
        return

    done = sum(s["status"] == "completed" for s in steps)
    current = next((s for s in steps if s["status"] == "in_progress"), None)
    if current is None:
        current = next((s for s in steps if s["status"] == "pending"), None)
    label = short_text(current["step"], 36) if current else "All steps done"
    path = plan_file(thread_id)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # The TUI polls concurrently. A read always sees an entire update.
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            json.dump(dict(done=done, count=len(steps), label=label, updated=time.time()), f)
            f.flush()
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)


def short_text(value, limit):
    text = " ".join("".join(c if c.isprintable() else " " for c in value).split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def progress(thread_id):
    if not thread_id:
        return None
    try:
        plan = json.loads(plan_file(thread_id).read_text())
        done, count = plan["done"], plan["count"]
        if count <= 0 or (done == count and time.time() - plan["updated"] >= 20):
            return None
        filled = 10 * done // count
        return f"{'█' * filled}{'░' * (10 - filled)} {done}/{count} {plan['label']}"
    except (OSError, ValueError, KeyError, TypeError):
        return None


def tokens(n):
    for size, suffix in ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "k")):
        if n >= size:
            return f"{n / size:.1f}".rstrip("0").rstrip(".") + suffix
    return str(n)


def render(state):
    thread = state.get("thread", {})
    model = thread.get("model", {})
    usage = thread.get("usage", {})
    context = usage.get("context") or {}
    total = usage.get("total") or {}
    children = []

    def add(value, color):
        children.append({"type": "text", "props": {"color": color}, "children": [value]})

    plan = progress(thread.get("id"))
    if plan:
        add(plan, "status-progress")
    model_label = model.get("display_name") or model.get("id") or "Codex"
    if model.get("reasoning_level"):
        model_label += " · " + model["reasoning_level"]
    add(short_text(model_label, 64), "status-model")

    ctx = []
    if context.get("used_percentage") is not None:
        ctx.append(f"{context['used_percentage']:.0f}%")
    if context.get("used_tokens") is not None and context.get("context_window_size"):
        ctx.append(f"{tokens(context['used_tokens'])}/{tokens(context['context_window_size'])}")
    if ctx:
        add("ctx " + " ".join(ctx), "status-usage")
    for field, label in (("total_input_tokens", "in"), ("output_tokens", "out")):
        if total.get(field) is not None:
            add(f"{tokens(total[field])} {label}", "status-usage")
    return {"type": "row", "props": {"gap": 2, "wrap": "wrap"}, "children": children}


def respond(method, params):
    if method == "initialize":
        return {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "plan-bar", "version": "0.6.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [TOOL]}
    if method == "tools/call":
        if params.get("name") != TOOL["name"]:
            raise ValueError("Unknown tool name")
        return {
            "content": [{"type": "text", "text": f"The statusline resource is {URI}."}]
        }
    if method == "resources/list":
        return {
            "resources": [
                {"name": "footer", "uri": URI, "mimeType": "application/json"}
            ]
        }
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/read":
        if params.get("uri") != URI:
            raise ValueError("Unknown resource URI")
        state = params.get("_meta", {}).get("com.openai/codex-statusline-state", {})
        return {
            "contents": [
                {
                    "uri": URI,
                    "mimeType": "application/json",
                    "text": json.dumps(render(state), ensure_ascii=False),
                }
            ]
        }
    raise KeyError(method)


def main():
    for line in sys.stdin.buffer:
        reply = {"jsonrpc": "2.0", "id": None}
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(
                request.get("method"), str
            ):
                reply["error"] = {"code": -32600, "message": "Invalid request"}
            elif "id" not in request:
                continue
            else:
                reply["id"] = request["id"]
                reply["result"] = respond(request["method"], request.get("params", {}))
        except json.JSONDecodeError:
            reply["error"] = {"code": -32700, "message": "Parse error"}
        except KeyError:
            reply["error"] = {"code": -32601, "message": "Method not found"}
        except (TypeError, ValueError, AttributeError):
            reply["error"] = {"code": -32602, "message": "Invalid parameters"}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["record"]:
        record(json.load(sys.stdin))
    else:
        main()
