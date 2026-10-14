# WebGL wrapper family check

This narrow verifier checks the generated wrappers under Firefox's
`dom/canvas/test/webgl-conf/generated/` at one pinned Git commit. It needs Python
3.11 or later and an existing local Firefox checkout. It uses standard-library
modules and Git. It does not use a census database or a knowledge-store cache.

```sh
python3 commands/knowledge/ingestion-webgl-family.py \
  --repository /path/to/firefox \
  --revision 1a097ed8d31f6b307a5d0ebc34a82ceaf7f3727b \
  --output-dir /path/to/private-output/new-webgl-check
```

The revision must be a full commit ID. The output directory must not exist; its
parent must exist. Keep it outside source, tool, shared knowledge and Git
directories. The command rejects source, tool and Git metadata directories,
symlink path components, and existing destinations. It reads committed blobs,
not working files. It sets `GIT_NO_LAZY_FETCH=1` and `GIT_TERMINAL_PROMPT=0`; missing
local objects fail instead of triggering a partial-clone fetch. It never executes
the source generator, imports a live knowledge store, or publishes files.

The check records each wrapper's exact blob ID, substituted target and WebGL
version. It compares every wrapper byte with the pinned template and checks that
the target is a regular file in the pinned tree. Each wrapper must appear in
exactly one manifest. Every generated manifest must appear exactly once in
`generated/moz.build`; unexpected family files or build statements fail.

The output contains:

- `wrapper-members.jsonl`: one independent row per wrapper, including failures.
- `manifest-contexts.json`: manifest defaults and per-test settings, kept separate.
- `family-check-results.json`: source revision, source and artifact hashes,
  counts, timings, failures and limits.

Exit status is 0 for passing checks, 1 for recorded membership failures, and 2
for input, unsupported-format or execution errors. An execution error can leave
a partial output directory; use a fresh destination for another attempt.

These are mechanical membership checks. They do not explain the target test
bodies or prove that tests pass. They do not evaluate parent build traversal,
manifest condition merging, platform skip conditions, support-file globs, or
browser behavior. The shared wrapper, caller, state and cleanup behavior needs
separate source analysis and independent review. Reusing that review also needs
checked source revisions and member-specific context. Command timings do not
measure the complete analysis, review and publication process.

Run the focused checks with:

```sh
python3 test/knowledge-ingestion-webgl-family.test.py
```

The fixture checks pinned reads, template mismatch, missing targets, missing build
registration and output isolation. Its generator would raise an error if executed.
The real pinned family must also be checked before publishing a new family claim.
