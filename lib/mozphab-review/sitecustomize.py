"""Handle case-only renames and Thunderbird bases in review stacks."""

import functools
import json
import os
import subprocess
import sys


def has_case_only_rename(diff):
    source = None
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            source = None
        elif line.startswith("rename from "):
            source = line[len("rename from "):]
        elif line.startswith("rename to ") and source is not None:
            target = line[len("rename to "):]
            if source != target and source.casefold() == target.casefold():
                return True
    return False


def apply_case_rename(diff, cwd):
    def git(*args, input=None):
        return subprocess.run(
            ["git", *args], cwd=cwd, input=input, stdout=subprocess.PIPE,
            check=True,
        ).stdout

    # A review starts clean. Do not overwrite an experiment or a staged change.
    git("diff", "--quiet")
    git("diff", "--cached", "--quiet")
    # Apply to the index first. The disk cannot hold both spellings at once.
    git("apply", "--cached", "-", input=diff.encode("utf8"))
    deleted = git("diff", "--cached", "--no-renames", "--diff-filter=D",
                  "--name-only", "-z").split(b"\0")
    changed = git("diff", "--cached", "--no-renames", "--diff-filter=ACMT",
                  "--name-only", "-z")
    for name in deleted:
        if name:
            os.unlink(os.path.join(os.fsencode(cwd), name))
    if changed:
        git("checkout-index", "--force", "-z", "--stdin", input=changed)


def install_review_patch():
    from mozphab.git import Git

    original = Git.apply_patch

    @functools.wraps(original)
    def apply_patch(self, diff, body, author, author_date):
        if not has_case_only_rename(diff):
            return original(self, diff, body, author, author_date)
        apply_case_rename(diff, self.path)
        self.commit(body, author, author_date)

    Git.apply_patch = apply_patch


def find_review_landing_node(cwd, main_hash, before):
    if before is None:
        return None
    # Comm main contains landed commits without mozilla-central merge messages.
    # Use its pinned history so later landings and local patch branches stay out.
    node = subprocess.check_output(
        ["git", "log", "--first-parent", main_hash, f"--before=@{before}",
         "-1", "--format=%H"], cwd=cwd,
    ).decode().strip()
    return node or None


def install_review_base():
    from mozphab.git import Git

    original = Git.get_latest_landing_node

    @functools.wraps(original)
    def get_latest_landing_node(self, before=None):
        main_hash = os.environ.get("TB_TOOLS_MOZPHAB_REVIEW_MAIN")
        if not main_hash:
            return original(self, before=before)
        return find_review_landing_node(self.path, main_hash, before)

    Git.get_latest_landing_node = get_latest_landing_node


def install_review_export():
    from mozphab.git import Git

    original = Git.format_patch
    patches = []

    @functools.wraps(original)
    def format_patch(self, diff, body, author, author_date):
        destination = os.environ.get("TB_TOOLS_MOZPHAB_REVIEW_EXPORT")
        if destination:
            patches.append(dict(diff=diff, body=body, author=author, date=author_date))
            with open(destination, "w", encoding="utf8") as output:
                json.dump(patches, output)
        return original(self, diff, body, author, author_date)

    Git.format_patch = format_patch


if os.environ.get("TB_TOOLS_MOZPHAB_REVIEW") == "1":
    try:
        install_review_patch()
        install_review_base()
        install_review_export()
    except Exception:
        sys.stderr.write("Cannot install the moz-phab review patch handler. Review stopped.\n")
        sys.stderr.flush()
        os._exit(1)
