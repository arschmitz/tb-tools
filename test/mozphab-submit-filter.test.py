import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "submit_filter", Path(__file__).parent.parent / "lib/mozphab-submit/sitecustomize.py"
)
submit_filter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(submit_filter)
MESSAGE = (
    "Bug 123456 - Calendar change\n\nKeep calendar selection.\n\n"
    "TB-Tools-Id: local-id\nTb-Implement-Step: old-step\n"
    "Tb-Try-Monitor: monitor\nTb-Try-Repair: repair\n"
    "Differential Revision: https://phabricator.services.mozilla.com/D123456\n"
)


class FilterTests(unittest.TestCase):
    def test_revision_summary_and_local_message(self):
        original = {"transactions": [{"type": "summary", "value": MESSAGE},
                                     {"type": "comment", "value": "Keep TB-Tools-Id: in this explanation"}]}
        result = submit_filter.filter_request("differential.revision.edit", original)
        self.assertNotIn("TB-Tools-Id:", result["transactions"][0]["value"])
        self.assertNotIn("Tb-Implement-Step:", result["transactions"][0]["value"])
        self.assertNotIn("Tb-Try-", result["transactions"][0]["value"])
        self.assertIn("Differential Revision:", result["transactions"][0]["value"])
        self.assertEqual(original["transactions"][0]["value"], MESSAGE)
        self.assertEqual(result["transactions"][1], original["transactions"][1])

    def test_diff_commit_metadata(self):
        original = {"name": "local:commits", "data": json.dumps({"hash": {"message": MESSAGE, "parents": ["parent"]}})}
        result = submit_filter.filter_request("differential.setdiffproperty", original)
        commit = json.loads(result["data"])["hash"]
        self.assertNotIn("TB-Tools-Id:", commit["message"])
        self.assertIn("Differential Revision:", commit["message"])
        self.assertEqual(commit["parents"], ["parent"])
        self.assertEqual(json.loads(original["data"])["hash"]["message"], MESSAGE)

    def test_unrelated_requests_and_quoted_text(self):
        original = {"name": "other", "data": MESSAGE}
        self.assertIs(submit_filter.filter_request("differential.setdiffproperty", original), original)
        text = "Explain TB-Tools-Id: here\n> TB-Tools-Id: quoted\n"
        self.assertEqual(submit_filter.strip_internal_trailers(text), text.rstrip())

    def test_parser_and_windows_newlines(self):
        result = submit_filter.filter_request("differential.parsecommitmessage", {"corpus": MESSAGE.replace("\n", "\r\n")})
        self.assertNotIn("TB-Tools-Id:", result["corpus"])
        self.assertIn("Differential Revision:", result["corpus"])


if __name__ == "__main__":
    unittest.main()
