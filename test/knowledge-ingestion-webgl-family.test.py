"""Check WebGL membership failures against a small pinned local Git fixture."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "commands/knowledge/ingestion-webgl-family.py"
BASE = "dom/canvas/test/webgl-conf/"
WRAPPER = BASE + "generated/test_conformance__example.html"
TEMPLATE = "<iframe src='checkout/%%TEST_PATH%%%%ARGS%%'></iframe>\n"


class FamilyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.repository = self.root / "source"
        self.repository.mkdir()
        self.git("init", "--quiet")
        files = {
            BASE + "mochi-wrapper.html.template": TEMPLATE,
            BASE + "generate-wrappers-and-manifest.py": "raise RuntimeError('must not execute')\n",
            BASE + "checkout/conformance/example.html": "<title>Target body</title>\n",
            WRAPPER: TEMPLATE.replace("%%TEST_PATH%%", "conformance/example.html").replace("%%ARGS%%", ""),
            BASE + "generated/example.toml": '[DEFAULT]\nskip-if = ["false"]\n["test_conformance__example.html"]\n',
            BASE + "generated/moz.build": 'MOCHITEST_MANIFESTS += ["example.toml"]\n',
        }
        for path, text in files.items():
            self.write(path, text)
        self.commit()

    def git(self, *arguments):
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        return subprocess.check_output(
            ["git", "-C", str(self.repository), "-c", "core.hooksPath=/dev/null",
             "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *arguments],
            env=env, stderr=subprocess.PIPE,
        )

    def write(self, path, text):
        target = self.repository / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "--quiet", "--no-gpg-sign", "-m", "Fixture state")
        self.revision = self.git("rev-parse", "HEAD").decode().strip()

    def run_check(self, output=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--repository", str(self.repository),
             "--revision", self.revision, "--output-dir", str(output or self.root / "result")],
            capture_output=True, text=True,
        )

    def test_pinned_family_and_unexecuted_generator(self):
        self.write(WRAPPER, "uncommitted change must not be read")
        result = self.run_check()
        self.assertEqual(result.returncode, 0, "Pinned wrappers should pass without reading working files or executing the generator.")
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["fullByteMembersPassed"], 1, "One pinned wrapper should pass all membership checks.")
        self.assertEqual(receipt["uniqueTargets"], 1, "The pinned target should be retained separately.")

    def test_altered_template_fails(self):
        self.write(BASE + "mochi-wrapper.html.template", TEMPLATE.replace("iframe", "frame"))
        self.commit()
        result = self.run_check()
        self.assertEqual(result.returncode, 1, "Wrappers from an older template should fail at the new revision.")
        self.assertIn("wrapper-template-mismatch", result.stdout, "The receipt should identify the template mismatch.")

    def test_missing_target_fails(self):
        (self.repository / (BASE + "checkout/conformance/example.html")).unlink()
        self.commit()
        result = self.run_check()
        self.assertEqual(result.returncode, 1, "A wrapper with a missing pinned target should fail.")
        self.assertIn("missing-pinned-target", result.stdout, "The receipt should identify the missing target.")

    def test_missing_manifest_registration_fails(self):
        self.write(BASE + "generated/moz.build", "MOCHITEST_MANIFESTS += []\n")
        self.commit()
        result = self.run_check()
        self.assertEqual(result.returncode, 1, "An unregistered manifest should fail.")
        self.assertIn("manifest-build-mismatch", result.stdout, "The receipt should identify the missing build registration.")

    def test_invalid_build_syntax_fails_without_receipt(self):
        self.write(BASE + "generated/moz.build", "MOCHITEST_MANIFESTS += [\n")
        self.commit()
        result = self.run_check()
        self.assertEqual(result.returncode, 2, "Invalid build syntax should return an unsupported-format error.")
        self.assertFalse((self.root / "result").exists(), "Invalid build syntax should not create a membership receipt.")

    def test_existing_source_and_symlink_outputs_fail(self):
        existing = self.root / "existing"
        existing.mkdir()
        link = self.root / "link"
        link.symlink_to(existing, target_is_directory=True)
        for output in (existing, self.repository / "output", self.repository / ".git" / "output", link / "output"):
            with self.subTest(output=str(output)):
                result = self.run_check(output)
                self.assertEqual(result.returncode, 2, "An existing, source, Git or symlink output should be rejected.")
        self.assertEqual(list(existing.iterdir()), [], "Rejected output paths should leave existing contents unchanged.")


if __name__ == "__main__":
    unittest.main()
