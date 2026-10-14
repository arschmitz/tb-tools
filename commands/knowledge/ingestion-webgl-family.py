"""Check pinned WebGL wrapper bytes, targets, manifests and build registration."""

import argparse
import ast
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import time
import tomllib


BASE = "dom/canvas/test/webgl-conf/"
PREFIX = BASE + "generated/"
TEMPLATE = BASE + "mochi-wrapper.html.template"
GENERATOR = BASE + "generate-wrappers-and-manifest.py"


def git(repository, *arguments, input=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0")
    return subprocess.check_output(
        ["git", "-C", str(repository), "-c", "core.hooksPath=/dev/null", *arguments],
        input=input, env=env, stderr=subprocess.PIPE, timeout=60,
    )


def output_destination(value, repository):
    destination = Path(os.path.abspath(value))
    for part in (destination, *destination.parents):
        if part.is_symlink() or part.name == ".git":
            raise ValueError("Output paths must not contain symlinks or .git directories.")
    if destination.exists() or not destination.parent.is_dir():
        raise ValueError("Output directory must be new and its parent must exist.")

    roots = [repository, Path(__file__).resolve().parents[2]]
    for option in ("--absolute-git-dir", "--git-common-dir"):
        location = Path(git(repository, "rev-parse", option).decode().strip())
        roots.append((repository / location).resolve())
    if any(destination == root or root in destination.parents for root in roots):
        raise ValueError("Outputs must stay outside source, tool and Git directories.")
    return destination


def read_sources(repository, revision):
    entries = {}
    raw = git(repository, "ls-tree", "-r", "-z", revision, "--", BASE)
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        metadata, path = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        entries[path.decode()] = {"mode": mode, "kind": kind, "oid": oid}

    family = sorted(path for path in entries if path.startswith(PREFIX))
    if not family:
        raise ValueError("The pinned tree has no generated WebGL family.")
    paths = family + [TEMPLATE, GENERATOR]
    for path in paths:
        if path not in entries or entries[path]["mode"] not in ("100644", "100755"):
            raise ValueError("Missing or non-regular source: " + path)
    oids = list(dict.fromkeys(entries[path]["oid"] for path in paths))
    started = time.monotonic()
    raw = git(repository, "cat-file", "--batch", input=("\n".join(oids) + "\n").encode())
    offset = 0
    blobs = {}
    for expected in oids:
        end = raw.index(b"\n", offset)
        header = raw[offset:end].decode().split()
        if len(header) != 3 or header[0] != expected or header[1] != "blob":
            raise ValueError("Unexpected local Git object response: " + repr(header))
        size = int(header[2])
        body = raw[end + 1:end + 1 + size]
        identity = hashlib.sha1(b"blob " + str(size).encode() + b"\0" + body).hexdigest()
        if identity != expected or raw[end + 1 + size:end + 2 + size] != b"\n":
            raise ValueError("Local blob identity mismatch: " + expected)
        blobs[expected] = body
        offset = end + 2 + size
    if offset != len(raw):
        raise ValueError("Unexpected trailing local Git output.")
    return entries, family, blobs, time.monotonic() - started


def check_family(entries, family, blobs, revision):
    def content(path):
        return blobs[entries[path]["oid"]]

    template = content(TEMPLATE)
    if template.count(b"%%TEST_PATH%%%%ARGS%%") != 1 or template.count(b"%%") != 4:
        raise ValueError("Unsupported wrapper template placeholders.")
    before, after = template.split(b"%%TEST_PATH%%%%ARGS%%")
    if not before or not after:
        raise ValueError("Unsupported empty wrapper template boundary.")
    manifests = {}
    memberships = collections.defaultdict(list)
    failures = []
    for path in family:
        if path.endswith(".toml"):
            parsed = tomllib.loads(content(path).decode())
            if any(not isinstance(settings, dict) for settings in parsed.values()):
                raise ValueError("Unsupported manifest structure: " + path)
            manifests[path] = {
                "oid": entries[path]["oid"], "defaults": parsed.get("DEFAULT", {}),
                "tests": {name: settings for name, settings in parsed.items() if name != "DEFAULT"},
            }
            for name, settings in manifests[path]["tests"].items():
                resolved = posixpath.normpath(posixpath.join(PREFIX, name))
                memberships[resolved].append({"path": path, "section": name, "settings": settings})
        elif not path.endswith(".html") and path != PREFIX + "moz.build":
            failures.append({"kind": "unsupported-family-file", "path": path})

    build = ast.parse(content(PREFIX + "moz.build").decode())
    build_entries = []
    for node in build.body:
        if not (
            isinstance(node, ast.AugAssign) and isinstance(node.op, ast.Add)
            and isinstance(node.target, ast.Name) and node.target.id == "MOCHITEST_MANIFESTS"
        ):
            raise ValueError("Unsupported generated moz.build statement.")
        values = ast.literal_eval(node.value)
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise ValueError("Unsupported generated moz.build entries.")
        build_entries.extend(values)
    registered = [posixpath.normpath(posixpath.join(PREFIX, name)) for name in build_entries]
    if len(registered) != len(set(registered)) or set(registered) != set(manifests):
        failures.append({
            "kind": "manifest-build-mismatch",
            "missing": sorted(set(manifests) - set(registered)),
            "extra": sorted(set(registered) - set(manifests)),
            "duplicateEntries": len(registered) - len(set(registered)),
        })

    rows = []
    for path in family:
        if not path.endswith(".html"):
            continue
        body = content(path)
        row = {"path": path, "revision": revision, "oid": entries[path]["oid"], "bytes": len(body), "errors": []}
        filename = path.removeprefix(PREFIX)
        webgl2 = filename.startswith("test_2_")
        row["webglVersion"] = 2 if webgl2 else 1
        if not body.startswith(before) or not body.endswith(after):
            row["errors"].append("wrapper-template-mismatch")
        else:
            insertion = body[len(before):len(body) - len(after)].decode()
            args = "?webglVersion=2" if webgl2 else ""
            entry = insertion.removesuffix(args) if args else insertion
            expected_name = "test_" + ("2_" if webgl2 else "") + entry.replace("/", "__")
            if filename != expected_name:
                row["errors"].append("target-filename-mismatch")
            if template.replace(b"%%TEST_PATH%%", entry.encode()).replace(b"%%ARGS%%", args.encode()) != body:
                row["errors"].append("full-byte-render-mismatch")
            if not entry or any(c in entry for c in "?\n\r'\"#\\") or entry.startswith("/"):
                row["errors"].append("unexpected-entry-character")
            target = posixpath.normpath(BASE + "checkout/" + entry)
            target_info = entries.get(target, {})
            row.update(entry=entry, args=args, target=target, targetOid=target_info.get("oid"))
            if target_info.get("mode") not in ("100644", "100755"):
                row["errors"].append("missing-pinned-target")
        row["manifests"] = memberships.get(path, [])
        if len(row["manifests"]) != 1:
            row["errors"].append("expected-one-manifest-membership")
        if any(member["path"] not in registered for member in row["manifests"]):
            row["errors"].append("manifest-not-build-registered")
        if row["errors"]:
            failures.append({"path": path, "errors": row["errors"]})
        rows.append(row)
    if not rows:
        failures.append({"kind": "empty-wrapper-family"})
    for path in sorted(set(memberships) - {row["path"] for row in rows}):
        failures.append({"kind": "manifest-nonwrapper-target", "path": path})
    return rows, manifests, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--revision", required=True, help="Full 40-character Git commit ID")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    clock = time.monotonic()
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise ValueError("Revision must be a full lowercase 40-character Git commit ID.")
    repository = Path(git(args.repository, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    revision = git(repository, "rev-parse", "--verify", args.revision + "^{commit}").decode().strip()
    if revision != args.revision:
        raise ValueError("Revision must identify the commit directly.")
    destination = output_destination(args.output_dir, repository)
    entries, family, blobs, read_seconds = read_sources(repository, revision)
    rows, manifests, failures = check_family(entries, family, blobs, revision)
    receipt = {
        "version": 1, "startedAt": started_at,
        "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "analysisElapsedSeconds": time.monotonic() - clock,
        "localBlobReadSeconds": read_seconds,
        "sourceRevision": revision, "sourceRepository": "firefox",
        "transport": "local Git with GIT_NO_LAZY_FETCH=1; no fetch or source generator",
        "template": {"path": TEMPLATE, "oid": entries[TEMPLATE]["oid"]},
        "generator": {"path": GENERATOR, "oid": entries[GENERATOR]["oid"]},
        "familyOrigins": len(family), "wrapperOrigins": len(rows),
        "manifestOrigins": len(manifests), "buildOrigins": 1,
        "uniqueTargets": len({row["target"] for row in rows if "target" in row}),
        "wrapperSourceBytes": sum(row["bytes"] for row in rows),
        "readBlobCount": len(blobs), "readBlobBytes": sum(len(body) for body in blobs.values()),
        "wrapperVersions": dict(collections.Counter(row["webglVersion"] for row in rows)),
        "fullByteMembersPassed": sum(not row["errors"] for row in rows),
        "failures": failures, "passed": not failures,
        "checkerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "limits": [
            "Mechanical membership checks do not establish full behavioral understanding.",
            "Target existence uses the pinned tree; target bodies are not read or credited.",
            "Manifest defaults and sections stay separate; harness conditions and support-file globs are not evaluated.",
            "Only generated/moz.build registration is checked; parent build traversal is not evaluated.",
            "No product tests, source generator, publication or knowledge-store import ran.",
            "Timings cover this command's analysis only, not semantic review or publication.",
        ],
    }
    destination.mkdir()
    outputs = {
        "wrapper-members.jsonl": "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        "manifest-contexts.json": json.dumps(manifests, indent=2) + "\n",
    }
    receipt["artifacts"] = {}
    for name, text in outputs.items():
        encoded = text.encode()
        with (destination / name).open("xb") as stream:
            stream.write(encoded)
        receipt["artifacts"][name] = {"sha256": hashlib.sha256(encoded).hexdigest(), "bytes": len(encoded)}
    receipt["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    receipt["elapsedSeconds"] = time.monotonic() - clock
    with (destination / "family-check-results.json").open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, SyntaxError, subprocess.SubprocessError) as error:
        print("WebGL family check failed: " + str(error), file=sys.stderr)
        sys.exit(2)
