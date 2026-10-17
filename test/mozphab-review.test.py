import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import ModuleType

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "review_patch", Path(__file__).parent.parent / "lib/mozphab-review/sitecustomize.py"
)
review_patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review_patch)


class ReviewPatchTests(unittest.TestCase):
    def test_review_base_uses_pinned_main_before_upload(self):
        with tempfile.TemporaryDirectory() as cwd:
            def git(*args, date=None):
                import os
                env = dict(os.environ)
                if date:
                    env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
                return subprocess.check_output(["git", *args], cwd=cwd, env=env).decode().strip()

            git("init", "-q", "-b", "main")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.invalid")
            git("commit", "--allow-empty", "-qm", "Landed comm base", date="2026-10-10T00:00:00Z")
            base = git("rev-parse", "HEAD")
            git("switch", "-qc", "unlanded")
            git("commit", "--allow-empty", "-qm", "Side branch", date="2026-10-11T00:00:00Z")
            git("switch", "-q", "main")
            git("merge", "--no-ff", "-qm", "Merge side branch", "unlanded", date="2026-10-13T00:00:00Z")
            main = git("rev-parse", "HEAD")
            git("commit", "--allow-empty", "-qm", "Later main", date="2026-10-14T00:00:00Z")
            git("switch", "-q", "unlanded")
            self.assertEqual(review_patch.find_review_landing_node(cwd, main, 1791763200), base,
                             "The fallback should use first-parent main history before upload.")
            self.assertEqual(review_patch.find_review_landing_node(cwd, main, 1792022400), main,
                             "The fallback should exclude commits after the pinned main.")
            self.assertIsNone(review_patch.find_review_landing_node(cwd, main, 1),
                              "The fallback should return no base before history starts.")
            self.assertIsNone(review_patch.find_review_landing_node(cwd, main, None),
                              "The fallback should require an upload timestamp.")

    def test_base_adapter_preserves_other_repositories(self):
        class Git:
            path = "/review/comm"

            def get_latest_landing_node(self, before=None):
                return ("original", before)

        module = ModuleType("mozphab.git")
        module.Git = Git
        with patch.dict(sys.modules, {"mozphab.git": module}), patch.dict(
            review_patch.os.environ, {"TB_TOOLS_MOZPHAB_REVIEW_MAIN": ""}
        ):
            review_patch.install_review_base()
            self.assertEqual(Git().get_latest_landing_node(before=123), ("original", 123),
                             "The adapter should preserve the original fallback without a comm baseline.")
            with patch.dict(review_patch.os.environ, {"TB_TOOLS_MOZPHAB_REVIEW_MAIN": "pinned"}), patch.object(
                review_patch, "find_review_landing_node", return_value="base"
            ) as lookup:
                self.assertEqual(Git().get_latest_landing_node(before=123), "base",
                                 "The adapter should use the configured comm baseline.")
                lookup.assert_called_once_with("/review/comm", "pinned", 123)

    def test_export_preserves_raw_output_and_stack_metadata(self):
        class Git:
            def format_patch(self, diff, body, author, author_date):
                return diff

        module = ModuleType("mozphab.git")
        module.Git = Git
        with tempfile.TemporaryDirectory() as cwd, patch.dict(sys.modules, {"mozphab.git": module}), patch.dict(
            review_patch.os.environ, {"TB_TOOLS_MOZPHAB_REVIEW_EXPORT": ""}
        ):
            review_patch.install_review_export()
            self.assertEqual(Git().format_patch("raw", "body", None, None), "raw",
                             "The adapter should preserve raw output without an export request.")
            destination = str(Path(cwd) / "stack.json")
            with patch.dict(review_patch.os.environ, {"TB_TOOLS_MOZPHAB_REVIEW_EXPORT": destination}):
                for body in ["parent", "selected"]:
                    self.assertEqual(Git().format_patch("raw", body, "Author", 123), "raw",
                                     "Exporting metadata should preserve raw output.")
            records = review_patch.json.loads(Path(destination).read_text())
            self.assertEqual([record["body"] for record in records], ["parent", "selected"],
                             "The export should preserve stack order.")
            self.assertEqual(records[0], dict(diff="raw", body="parent", author="Author", date=123),
                             "The export should preserve exact author, date, body and diff.")

    def test_stack_with_case_rename_and_dependent_change(self):
        with tempfile.TemporaryDirectory() as cwd:
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=cwd).decode()

            git("init", "-q")
            git("config", "user.name", "Test")
            git("config", "user.email", "test@example.invalid")
            git("config", "core.ignorecase", "true")
            source = Path(cwd) / "SearchDialog.js"
            source.write_text("parent\n")
            git("add", ".")
            git("commit", "-qm", "baseline")
            patch = (
                "diff --git a/SearchDialog.js b/searchDialog.js\n"
                "rename from SearchDialog.js\nrename to searchDialog.js\n"
                "--- a/SearchDialog.js\n+++ b/searchDialog.js\n"
                "@@ -1 +1 @@\n-parent\n+renamed parent\n"
            )
            self.assertTrue(review_patch.has_case_only_rename(patch))
            review_patch.apply_case_rename(patch, cwd)
            self.assertEqual(git("ls-files"), "searchDialog.js\n")
            self.assertEqual(sorted(p.name for p in Path(cwd).iterdir() if p.name != ".git"), ["searchDialog.js"])
            self.assertEqual((Path(cwd) / "searchDialog.js").read_text(), "renamed parent\n")
            git("commit", "-qam", "parent")
            child = (
                "diff --git a/searchDialog.js b/searchDialog.js\n"
                "--- a/searchDialog.js\n+++ b/searchDialog.js\n"
                "@@ -1 +1 @@\n-renamed parent\n+selected patch\n"
            )
            subprocess.run(["git", "apply", "--index", "-"], cwd=cwd,
                           input=child.encode(), check=True)
            git("commit", "-qm", "selected")
            self.assertEqual(git("show", "HEAD^:searchDialog.js"), "renamed parent\n")
            self.assertEqual(git("show", "HEAD:searchDialog.js"), "selected patch\n")
            (Path(cwd) / "searchDialog.js").write_text("experiment\n")
            with self.assertRaises(subprocess.CalledProcessError):
                review_patch.apply_case_rename(patch, cwd)
            self.assertEqual((Path(cwd) / "searchDialog.js").read_text(), "experiment\n")

    def test_ordinary_rename_uses_normal_handler(self):
        self.assertFalse(review_patch.has_case_only_rename(
            "diff --git a/old b/new\nrename from old\nrename to new\n"
        ))


if __name__ == "__main__":
    unittest.main()
