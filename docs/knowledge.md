# Console knowledge

The core is an independently runnable package in the sibling
`thunderbird-knowledge` Git repository. See its
standalone README for `tb-knowledge`, evidence
submission, and shared Git contribution rules. `commands/knowledge-service.mjs`
adapts it to tb-tools configuration and command discovery. Both use one format and
implementation. No service or network request is required for local retrieval.

The repository `AGENTS.md` points agents to this workflow. The knowledge store's
`AGENTS.md` contains the full instructions, and the console supplies those same
instructions on every AI turn, including follow-ups. Historical records do not
become instructions. Native Codex memory use and generation are disabled for
console child processes; other desktop chats keep their settings.

Patch history now writes to `private/patch-history` inside the configured store.
Old global patch notes are copied to `private/legacy-patch-history` by the importer
without changing their originals. New console writes do not use global memory.

When `ai.enabled` is true, the console learns from AI work automatically. Knowledge
is stored outside source checkouts in `~/.tb-tools/knowledge`. Node.js 22.13 or later
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
search. The model runs in a separate process on this computer. Its first use downloads model
files from Hugging Face; source text is not sent there. Model files and indexes
are local caches, not Git content. Exact search continues when the model is not
ready or a download fails. A native model crash cannot close the console. Exact
search remains available if the model process stops. Query embedding waits at most 300 milliseconds.

The console adds at most 10,000 characters of retrieved evidence by default.
Relevant records include paths to their full evidence. Current code and explicit
instructions take precedence over historical claims. Newer evidence receives a
small ranking preference, not authority over older decisions.
For retrieved lessons with paths and an exact source revision, the console checks
whether those files changed and tells the agent when current-source checks are needed.

Maintenance runs every 30 seconds while the console is open. It imports changed
notes, indexes missing vectors in small batches, syncs at most every five minutes,
and processes bounded evidence batches. At most four extraction calls run per UTC
day by default, shared across local consoles. Calls have a 90-second limit; failed
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

No remote is created or inferred. Set `remote` to a dedicated empty Git repository
or one already using this record format. All users can pull when the Git host grants
read access. Set `push: false` for readers. The Git host enforces writer permission.
Failed pushes retain local records and retry on later maintenance runs.
Local records are committed automatically to the private `history.git` repository
even without a remote. That repository is never pushed. Shared sync uses a separate
`transport.git` repository so private parent commits cannot enter shared history.

Records are private by default. Adding a repository identity to `shareRepositories`
authorizes automatic publication of future commit snapshots and structured review
feedback for that repository. Only enable this for a destination whose readers may
access all such material, including restricted reviews. This setting does not make
private data public retroactively. Personal task transcripts and imported memories
remain private even when their repository is enabled. Lessons inherit the most
restrictive visibility of their evidence. Existing shared records remain shared
when the setting is removed; removing it only stops new publication.

Sync uses immutable files named by a SHA-256 content digest. A separate bare Git
repository builds a union of local and remote records. A concurrent rejected push
fetches and retries up to four times, without force-pushing. A local process lock
serializes sync. Remote files are validated as records and never checked out or
executed. Different claims can coexist; file merging does not establish which is
correct. Indexes, model files, private records, generated guides, and `AGENTS.md`
are never pushed. Git history is an audit trail, not a privacy deletion mechanism.

## Inspection

```sh
tb knowledge status
tb knowledge search --repository thunderbird 'Calendar dialog draft'
tb knowledge show RECORD_ID
tb knowledge import
tb knowledge maintain
tb knowledge sync
tb knowledge index
```

These commands return JSON. `maintain` can spend one extraction call within the
daily limit. The other commands do not make a Codex call. `search` uses exact
local search from the CLI; console tasks also use meaning-based search when ready.
`--directory` selects another knowledge directory. Status includes counts, recent
retrieval size/time, learning and sync outcomes, and failures. These observations
do not establish that memory improves review or generation quality.
`index` downloads the local embedding model if needed and builds missing vectors.
Normal console maintenance also builds them automatically in smaller batches.

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
