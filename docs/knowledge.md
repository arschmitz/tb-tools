# Console knowledge

The sibling `thunderbird-knowledge` Git repository holds shared knowledge and
instructions. It is readable and writable with ordinary file and Git tools.
The console owns all implementation code under `commands/knowledge`.
Set `ai.knowledge.repositoryDirectory` to the memory checkout. The console imports
Markdown notes and records, publishes eligible project lessons with readable notes,
exports shared records, commits new files, and syncs the checkout's `origin`.
Caches and private evidence stay in the local
`ai.knowledge.directory`. No standalone package dependency is required.

The repository `AGENTS.md` points agents to this workflow. The knowledge store's
`AGENTS.md` contains the full instructions, and the console supplies those same
instructions on every AI turn, including follow-ups. Historical records do not
become instructions. Native Codex memory use and generation are disabled for
console child processes; other desktop chats keep their settings.

Patch history now writes to `private/patch-history` inside the configured store.
Old global patch notes are copied to `private/legacy-patch-history` by the importer
without changing their originals. New console writes do not use global memory.

When `ai.enabled` is true, the console learns from AI work automatically. Knowledge
is shared through the memory repository; private evidence and search caches stay
in `~/.tb-tools/knowledge`. Node.js 22.13 or later
with `node:sqlite` is required. A knowledge failure is reported without stopping
the original task.

Each AI turn searches relevant records before starting. It records the original
request, final answer, and completed command, file, search, and connector events.
It does not record private reasoning. Tool evidence is capped at 160,000 characters
per turn; the record states when this limit omitted output. Failed and interrupted
turns are evidence, never proof of success. Original source references and exact
revisions are retained when available.

Commit snapshots and review-update outcomes also create records. Reading through
unrelated apps or outside the console is not captured. Existing Thunderbird and
TB Tools sections of `MEMORY.md` and patch-update notes are imported automatically.
The originals are unchanged. Imported notes remain private, unverified history.
Existing reusable-knowledge bullets seed provisional lessons without extra AI calls.

## Search and learning

SQLite provides local full-text search. A small MiniLM model supplies meaning-based
search. The model runs in a worker on this computer. Its first use downloads model
files from Hugging Face; source text is not sent there. Model files and indexes
are local caches, not Git content. Exact search continues when the model is not
ready or a download fails. Query embedding waits at most 300 milliseconds.

The console adds at most 10,000 characters of retrieved evidence by default.
Relevant records include paths to their full evidence. Current code and explicit
instructions take precedence over historical claims. Newer evidence receives a
small ranking preference, not authority over older decisions.
Retrieval groups a lesson with copied summaries and Markdown mirrors. Copies
cannot multiply its rank. Different claims and component scopes remain separate.
Source dates survive later publication and portability corrections.
For retrieved lessons with paths and an exact source revision, the console checks
whether those files changed and tells the agent when current-source checks are needed.

Maintenance runs every 30 seconds while the console is open. It imports changed
notes, indexes missing vectors in small batches, syncs at most every five minutes,
and processes bounded evidence batches. At most four extraction calls run per UTC
day by default, shared across local consoles. Derived mirrors and raw CI
observations remain searchable and receive an explicit `skipped` learning state.
That state does not claim their code or history was studied. Eligible evidence
alternates recent work and older pending evidence, with fewer attempts first.
New captures cannot continuously hide earlier work, and the backlog does not
hold every new task until all old records finish. Existing related lessons help
prevent duplicate claims.
Calls have a 90-second limit; failed
attempts count toward the budget and retry after an hour. Restarting does not reset
the budget or completed work. There is no background daemon after the console exits.

Extracted lessons must cite existing records and exact supporting quotes. Agent
interpretations remain provisional. A code snapshot checked against its recorded
revision or an explicitly kept review change can support a narrow lesson. A
source pattern does not by itself establish a repository-wide rule or verified
runtime behavior. A lesson only retires an earlier lesson when its evidence
explicitly names the replaced record in `source.replaces` and both have the same
scope.
Otherwise both remain available. Generated component guides collect up to twelve
recent lessons with evidence links; they are navigation aids, not policy.

## Configuration

Optional settings in `~/.tb.json`:

```json
{
  "ai": {
    "enabled": true,
    "knowledge": {
      "enabled": true,
      "directory": "~/.tb-tools/knowledge",
      "repositoryDirectory": "/path/to/thunderbird-knowledge",
      "semantic": true,
      "importLegacy": true,
      "maxCallsPerDay": 4,
      "maxContextChars": 10000,
      "remote": "",
      "push": true,
      "shareRepositories": [],
      "repositories": {}
    }
  }
}
```

Thunderbird comm clones share the identity `thunderbird`; this console uses
`tb-tools`. Other repositories use their root-commit identity. Use `repositories`
to map absolute checkout roots to a chosen stable identity when needed.

## Sharing

With `repositoryDirectory`, use the checkout's
`origin` remote and current branch. The repository contains AGENTS.md, README.md,
CONTRIBUTING.md, FORMAT.md, CONSUMING.md, SCHEMA.md, notes, and records. Readers set `push: false`; the Git
host enforces permissions. Shared notes are immutable. Add corrections as new
notes with explicit source references. Concurrent new files merge; conflicts in
shared instructions stop sync for review. Automatic commits never include tracked
edits or unrelated files. Local-only operation commits without pushing.

Without a checkout, the older `remote` setting still supports a records-only bare
transport. It does not accept documentation or notes. Prefer the shared checkout
for the human-readable memory repository. Private history is never pushed.

Records are private by default. Adding a repository identity to `shareRepositories`
authorizes automatic publication of future commit snapshots and structured review
feedback for that repository. Only enable this for a destination whose readers may
access all such material, including restricted reviews. Personal task transcripts
and imported memories remain private even when their repository is enabled.
The original extracted lesson inherits the visibility of its evidence; publication
creates a separate safe project summary and provisional shared lesson as described
below. Existing shared records remain shared
when the setting is removed; removing it only stops new publication.

For identities in `shareRepositories`, reusable project lessons derived from
private task captures and imported memories are also published automatically.
The shared summary retains original IDs and available source links. Its claim
remains provisional when the original evidence is private. Private quotes and
transcripts stay local. Common credential forms stop publication for review;
repository authorization still requires writers to avoid restricted content.
Readable notes link each published lesson to its shared supporting records.
Publication is idempotent and does not need another AI call. Readers with
`push: false` do not run automatic publication.

The shared checkout keeps human-written Markdown notes under unique names and
console records under content digests. Rejected concurrent pushes fetch and merge
before retrying, at most four times. A process lock serializes local console sync.
Incoming files are validated before merging; Git hooks are disabled for automatic
commands. Evidence text is never executed as instructions. Different claims can
coexist, and a file merge does not decide which is correct. Local indexes, model
files, private history, and generated guides stay outside the checkout.
Git history is an audit trail, not a privacy deletion mechanism.
Imports use file fingerprints and Git blob IDs to skip unchanged content. Batch
Git reads validate blob size and mode. Existing notes and records remain immutable.
`repair` appends portable replacements for old local log paths; old files remain
as audit evidence and retrieval selects corrected copies.

## Inspection

```sh
tb knowledge status
tb knowledge search --repository thunderbird 'Calendar dialog draft'
tb knowledge show RECORD_ID
tb knowledge import
tb knowledge maintain
tb knowledge sync
tb knowledge index
tb knowledge catalog --repository thunderbird
tb knowledge publish
tb knowledge repair
```

These commands return JSON. `maintain` can spend one extraction call within the
daily limit. The other commands do not make a Codex call. `search` uses exact
local search from the CLI; console tasks also use meaning-based search when ready.
`--directory` selects another knowledge directory. Status includes counts, recent
retrieval size/time, learning and sync outcomes, and failures. These observations
do not establish that memory improves review or generation quality.
`--repository-directory` selects a shared clone. `rebuild` imports it into a
fresh exact-search cache without running learning. `catalog` lists scoped lessons
for architecture, behavior, tests, syntax, naming, and style navigation.
The shared clone can also contain SKILLS.md, `skills/<name>/SKILL.md` and Markdown
files in each skill's `references/` directory. Sync accepts these committed
instructions without creating evidence or learning jobs from them. It does not
stage or install skills. Skill changes need deliberate review; executable files,
scripts and symlinks remain unsupported.
`lesson --file lessons.json` validates a cited extraction batch. `publish` writes
eligible lessons and syncs; `repair` only appends portable corrections and
classifies the learning queue. Follow `repair` with `publish` to share its records.
`index` downloads the local embedding model if needed and builds missing vectors.
Normal console maintenance also builds them automatically in smaller batches.
Starting a new model worker clears the current `semanticError` so an old failure
does not block a retry. Status keeps the previous diagnostic in
`semanticLastError`. A worker failure retains its first cause. Exact search still
works while the model starts or fails.

Records are the durable format. The SQLite index can be recreated from them; its
job state and usage counters should normally be retained to avoid repeated work.
Do not hand-edit immutable records. New evidence corrects old knowledge.

## Minimum test coverage:

- Concurrent immutable writes, checksum validation, index rebuild, repository
  isolation, bounded retrieval, and duplicate suppression.
- Private imports, changed-source import, cited extraction, invalid output,
  persistent budgets, and retries.
- Pull-only sync, concurrent writers, invalid remote files, private-record
  exclusion, offline recovery, and no force-push.
- AI-runner injection, evidence capture, failure isolation, and learning recursion
  prevention. Live model execution is checked separately from mocked tests.

## CI comparison evidence

Try assessment records exact failure signatures that also occur on comparison
pushes. Each record keeps the tested revision, target job IDs, matching push and
job links, and a path to the full matches. Unmatched signatures do not create
reuse claims. These records describe historical occurrences; they do not decide
whether an entire current run passed. Check independent comparison evidence and
all current failures before reusing a classification. Capture uses code, with no
extra AI call. Normal learning limits still apply.

Raw logs, completed job evidence, and complete comparison pushes are cached in
`~/.tb-tools/try-evidence`. Job keys include the repository, job, retry, and result.
Push lists and unfinished pushes are refreshed. Completed runs stay cached permanently, including explicit missing-evidence
records. Failed comparison downloads are skipped rather than blocking the scan. Log processing reads one line at a time.

CI capture also keeps compact observations for comparison pushes without a match
to the current patch, including other authors and comm-central. Each push summary
contains a few exact signature examples, the total signature count, and a link to
the full cached evidence. It does not copy entire logs into knowledge records.
