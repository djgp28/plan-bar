import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "codex"))
import statusline


class CodexFooterTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        home = patch.object(Path, "home", return_value=Path(temp.name))
        home.start()
        self.addCleanup(home.stop)

    def update(self, steps, **fields):
        args = [{"step": name, "status": status} for name, status in steps]
        statusline.record(dict(session_id="a", tool_name="update_plan",
                               tool_input={"plan": args}, **fields))

    def footer(self, thread_id, **fields):
        params = {"uri": statusline.URI, "_meta": {"com.openai/codex-statusline-state": {
            "thread": dict(id=thread_id, **fields)
        }}}
        resource = statusline.respond("resources/read", params)["contents"][0]
        return [cell["children"][0] for cell in json.loads(resource["text"])["children"]]

    def test_progress_context_and_cumulative_tokens(self):
        self.update([("Read", "completed"), ("Write tests", "in_progress")])
        metrics = dict(context=dict(used_percentage=25, used_tokens=32000, context_window_size=128000),
                       total=dict(total_input_tokens=140000, cache_read_input_tokens=100000, output_tokens=4000))
        self.assertEqual(self.footer("a", model=dict(display_name="Test model", reasoning_level="high"),
                                     usage=metrics),
                         ["█████░░░░░ 1/2 Write tests", "Test model · high", "ctx 25% 32k/128k",
                          "140k in", "4k out"])
        self.assertEqual(self.footer("b"), ["Codex"])

    def test_completed_plan_expires_and_new_plan_replaces_it(self):
        with patch.object(statusline.time, "time", return_value=100):
            self.update([("Read", "completed")])
            self.assertIn("1/1 All steps done", self.footer("a")[0])
        with patch.object(statusline.time, "time", return_value=121):
            self.assertEqual(self.footer("a"), ["Codex"])
            self.update([("Run tests", "in_progress")])
            self.assertIn("0/1 Run tests", self.footer("a")[0])
            self.update([])
            self.assertEqual(self.footer("a"), ["Codex"])

    def test_child_updates_stay_in_their_thread(self):
        self.update([("Main task", "in_progress")])
        self.update([("Child task", "in_progress")], agent_id="b")
        self.assertIn("Main task", self.footer("a")[0])
        self.assertIn("Child task", self.footer("b")[0])


if __name__ == "__main__":
    unittest.main()
