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

Comment-writing guidance is supplied directly by `knowledgeInstructions` on new
AI turns and follow-ups, even when retrieval is unavailable. Its text lives in
`commands/knowledge/comment-writing.mjs`. The shared checkout's AGENTS.md and
CONSUMING.md carry the same guidance and link to the cited practical guide.
The local Codex global AGENTS.md supplies it for Thunderbird work in fresh chats.
This is a deliberate user-directed instruction change, separate from automatic
learning. The coverage report records the completed file census and automated
grammar pass. It states the extraction limits and does not claim a manual review
of every comment.
Other computers and chats that already loaded their instructions need equivalent
instructions or a refreshed context; publication cannot update every Codex chat.

Code-style guidance is also supplied directly on new turns and follow-ups through
`commands/knowledge/code-style.mjs`. It selects rules for the exact language,
component, file role, and section. The shared CONSUMING.md links the practical
guide and coverage limits. Local Codex and shared AGENTS.md carry matching text.
The standalone style references include scoped loop choices and logical
blank-line grouping. Writing, review, and verification check useful groups between
steps separately from formatter and lint results. The console sends this guidance
even with knowledge retrieval disabled. Source counts do not establish global rules.
This is deliberate user-directed guidance; automatic learning must not edit it.
A running backend must reload the changed
module before its new turns receive this version.

Thunderbird scope guidance excludes Suite and SeaMonkey from history ingestion,
source analysis, knowledge use, examples, style, implementation, verification,
and review. Mixed changes retain only Thunderbird and shared Thunderbird code.
The console supplies this guidance through `knowledgeInstructions`, including
when retrieval is disabled. Shared and local Codex AGENTS.md carry the same scope.
This is a direct user instruction, not a conclusion from source age or counts.
Existing Suite records stay immutable and do not guide Thunderbird work.

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
search. The model runs in a separate process on this computer. Its first use downloads model
files from Hugging Face; source text is not sent there. Model files and indexes
are local caches, not Git content. Exact search continues when the model is not
ready or a download fails. A native model crash cannot close the console. Exact
search remains available if the model process stops. Query embedding waits at most 300 milliseconds.

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

Review findings have thumbs-up and thumbs-down buttons with an optional reason.
Click the selected rating again to clear it. Ratings do not post a comment or
apply code. Earlier saved or skipped findings can also be rated. Saved sessions
retain the original generated comment and code, the edited draft, the returned
inline ID, and the confirmed publication separately. Old sessions that already
lost their original suggestion remain unknown.

Update replies retain the generated reply, saved draft text and returned inline
ID. Follow-up checks compare that baseline with the confirmed remote comment.

Knowledge maintenance captures saved Review, Update, Verify and Implement results
as private evidence. New AI turn captures also keep the IDs of retrieved knowledge.
One in three extraction calls gives task outcomes priority. The existing daily
AI-call limit still applies; follow-up collection makes no extra AI calls.

Recurring patch ingestion waits for the current history study to finish its source,
review and bug discussion coverage. It does not treat source-only publication as
completion. After completion, it fetches the configured Git remote and reads all
new first-parent commits from its saved cursor. It does not switch the source
checkout or change its working files. Each batch keeps patch metadata and a bounded
diff, with an explicit truncation flag. A durable cursor advances only after a
record is written. Interrupted runs resume the same fixed target revision.

The default cadence is weekly, with up to two batches per UTC day. Each batch has
a 60-second time limit, 20 commits, five task or patch checks, and ten remote
lookups. A lookup can make several HTTP requests, especially when a browser loads
review history. Unfinished batches continue within the daily limit. A calendar
month is represented by 30 days. Maintenance runs only while the console is open.
Daily or monthly cadence can use the same small batch limits. Status reports the
remaining work, lookup count, errors and time limits so these limits can be tuned.

Follow-up checks read exact revision links, landed diffs, linked backout hashes,
review replies, bug comments and declared regression bugs. For saved findings,
they compare the original comment and supplied code with the published text.
They distinguish unchanged, edited, omitted, added and unknown code suggestions.
An inline ID can confirm the remote comment and link replies to it. Without a
remote match, a confirmed console publication stays labelled as such. Text found
in a landed patch is only a text match. It does not prove that the author accepted
the suggestion or that the behavior is correct. Bug IDs alone do not identify a
landed implementation. Missing evidence, silence and absence of a backout do not
count as success. Readers need Phabricator sign-in for complete inline discussions.

Configure `ai.knowledge.followUp` separately from the shared knowledge checkout:

```json
{
  "enabled": true,
  "repositoryPath": "/path/to/thunderbird/comm",
  "ref": "refs/remotes/origin/HEAD",
  "cadence": "weekly",
  "maxRunsPerDay": 2,
  "maxCommitsPerRun": 20,
  "maxTasksPerRun": 5,
  "maxRemoteLookupsPerRun": 10,
  "maxRunMs": 60000
}
```

The history owner can finish the gate with a cited evidence record whose source
type is `history-study-completion` and whose source revision is the exact end of
the completed manifest. Its JSON text must contain `fullSecondPassComplete: true`,
the manifest's `total`, and `contiguousThrough` equal to `total`. Record actual
completion only after all required discussions have been read. Then run:

```sh
tb knowledge history-complete COMPLETION_RECORD_ID
tb knowledge follow-up
tb knowledge status
```

The existing history study can also open the gate by setting
`fullSecondPassComplete: true` with contiguous coverage of the full manifest.
`follow-up` runs a bounded batch on demand, but cannot bypass the history gate or
daily batch limit. Raw task results and follow-up comparisons stay private. Normal
cited extraction and safe lesson publication share reusable conclusions.

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

### Local section index

Large records use a local section index for exact and semantic search. Markdown
headings start sections. Long sections and single-line maps are divided into
chunks of at most 1,200 text characters. Each model input includes up to 400
characters of the record title, component, and parent headings. Small records
stay whole. This fits the embedding worker's 2,000-character input limit; the
model can still apply its own token limit.

Sections keep deterministic IDs, the parent record ID, heading context, and
UTF-16 start and end offsets into the original text. Results cite the immutable
record and include the matching section's source file and offsets. Repository,
component, paths, source revision, symbol, and file role come from explicit
record fields when present. Heading text is context, not inferred symbol metadata.
Unstructured maps use bounded text chunks; this is not a source-language parser.

The SQLite cache holds sections and their vectors outside the shared checkout.
Opening an older cache builds sections from its existing records. New records
add sections in the same transaction. Section format changes rebuild sections
and discard section vectors; ordinary rebuilds retain vectors with stable IDs.
Old record vectors remain available for small records until section vectors are
ready. Large record vectors are replaced through incremental indexing in batches
of 32. Exact search needs no model. Original records, learning jobs, and settings
remain intact.

A local USearch index supplies approximate nearest neighbors for section vectors.
Each partition contains one repository, embedding model, and vector dimension.
Each graph file holds at most 4,096 vectors. Search combines candidates from the
graph files, keeps the best 240, and adds up to 128 recently indexed vectors from
the same partition. It scores at most 368 original vectors and loads only the
best matching section bodies. The recent rows protect newly added evidence.
Older neighbors depend on approximate traversal. The existing similarity
threshold and limit of 60 semantic section hits stay the same. Approximate
search can miss neighbors; exact rescoring cannot recover an omitted neighbor.

The console builds and updates this index automatically. Startup schedules a
batch of at most 16 rows. Pending batches yield between turns, and embedding
maintenance imports new vectors. A source change journal tracks replacements,
deletions, and changes to source identity. These changes start a bounded rebuild.
Search uses exact scoring until the rebuild finishes. New immutable vectors are
added incrementally. Large rebuilds can take longer than ordinary additions.
Each batch stops after a 20 ms target between rows. A native operation, graph
load or save, file flush, or lock wait can exceed that target.

Graph files are immutable. Maintenance saves and flushes each changed segment
before committing its filename, source mappings, cursor, and generation in a
separate SQLite database. Interrupted writes can leave disposable unused files;
later maintenance removes them. Search checks file hashes and graph shape when
opening files, and trusts only an index generation that matches its source
snapshot. It keeps at most 16 native graph views and reuses those objects when
opening other segments. File verification metadata has a separate bounded cache.
Closing the service cancels scheduled work and waits for an active batch. No
separate command is required. `vectorIndexStatus` records progress or an error.

Small or explicitly filtered searches, incomplete or stale indexes, unsupported
vectors, damaged files, and unavailable native bindings use exact streaming
vector search. Near-tied candidate cutoffs also use exact scoring to preserve
source order. Read-only evaluation snapshots use exact search. This fallback
scans vectors without loading every section body. Original records and vectors
remain the source of truth; the derived index can be rebuilt. Unsupported native
targets, including Windows ARM64 with the pinned library version, retain this
fallback. Trace output reports the method and fallback reason. The internal
`semanticMode: "exact"` option supports comparisons against approximate search.

Search keeps the best score per record for each search method and applies the
existing claim grouping, evidence ranking, explicit scope, and supersession rules.
Matching several sections does not add authority to a claim. The same source has
one entry in `result.ids`, even when several excerpts reach the task.

Search retains at most eight distinct matching sections per claim and returns at
most three. It removes repeated section IDs, identical text, and overlapping
ranges from the same physical source. Extra sections need a text or semantic
match of their own; shared record metadata alone is not enough. Each returned excerpt is a separate JSON
line with its canonical claim ID and exact section source, UTF-16 offsets, and
heading context. Aliases keep their physical source references. Section boundaries,
IDs, stored records, and embeddings do not change.

Search first selects the ranked primary sources under the existing context and
unique-claim limits. It then uses only the remaining space for extra sections,
adding them in rounds across selected sources. Supplements do not displace a
primary source that fits. The original primary passage stays ahead of the
candidate cap, including when different copies match exact and semantic searches.
`maxSectionsPerClaim` accepts 1 through 3; the default is 3. A value of 1 supports
controlled comparisons. Trace output lists selected and omitted sections.

Retrieval evaluation reports returned-anchor coverage separately from parent
source recall. It checks that required quotes reached the task with the right
source, revision, path, and offsets. Adjacent ranges from one source can support a
quote split at a section boundary. Disjoint text and different copies cannot be
joined to manufacture a quote. Requirements without quoted anchors remain
unmeasured for this metric. Scheduled gap checks use the same excerpt check and
receive original and current context separately from reviewer-only source text.

These bounds cannot guarantee that every relevant section fits. Large parent
path lists can still exclude a source even when its section text fits. Use `show`
with the record ID to inspect omitted text and complete scope. Passing retrieval
checks does not establish that a generated answer is correct.

### Questions and explicit scope filters

Search uses the question to choose a ranking preference. “Where is this
implemented?” favors source maps and implementation snapshots. “Why was this
changed?” favors commits, landed patches, and review feedback that explicitly
records acceptance and is not marked reverted. “How should I test this?” favors
recorded test roles, results, and harness evidence. Other matching evidence stays
available. Mixed, ambiguous, and unrecognized questions use general search.
Source dates do not prove current behavior. Navigation maps contain candidates
that must be checked against source. Review acceptance does not establish policy.

The search API accepts `question` separately from `query`. `question` defaults to
`query`. It also accepts explicit `filters`. These filters exclude records; an
inferred question preference only changes ranking.

Console tasks pass a separate `knowledgeRequest` with `question`, `taskType`,
`paths`, `symbols`, `revision`, and optional `filters`. Producers build this
request from the bug, selected patch, specific review comment, human guidance,
or failed job before adding workflow instructions or replacing a large prompt
with a file pointer. Repository identity still comes from the actual checkout.
The selected revision is context for source checks, not a strict history filter.

`startTurn` preserves that request through preparation, evidence checks, writing,
and final checks. `knowledgeQuery` continues to hold the complete task contract
for evidence validation and private task capture. Callers without structured
metadata use the beginning of the original request. Later phase instructions do
not replace it. Task paths are explicit; unrelated dirty files and the previous
HEAD commit do not supply fallback paths. A new implementation starts without
patch paths until it has its own commit.

Exact search runs up to three bounded queries for the question, explicit symbols,
and task paths. Each part has its own 80-term candidate search. Path matches have
half the question or symbol rank weight. Matching the same record in several
parts does not add authority. Standalone searches retain their existing term and
ranking behavior. Semantic search receives the focused question, symbols, and
paths, without the workflow prompt. Task type does not infer strict filters.

The question keeps its first 6,000 characters and records whether it was truncated.
Paths and symbols each retain at most 100 unique values. Path values over 4,096
characters and symbols over 512 characters are rejected. Each query part is at
most 6,000 characters; path and symbol parts retain whole values that fit.
Private query observations retain the normalized request and effective query
parts. Gap groups distinguish different task scope, and scheduled checks replay
the saved parts. A truncated question cannot automatically close its original
retrieval gap. These bounds do not shorten the task contract supplied to the agent.

```sh
tb knowledge search --repository thunderbird --component calendar \
  --language JavaScript --role test --generated false --imported false \
  'How should I test CachedStore?'
```

Filters require exact recorded values: `component` uses the record's `component`
or `source.component`; `language` uses `source.language`; `role` uses
`source.fileRole` (`production` or `test`). `generated` and `imported` use Boolean
source fields and require `true` or `false` on the CLI. The API takes Boolean
values. Missing metadata does not match, including missing `false` values.
Records marked `source.scopeUncertain: true`, `source.metadataInferred: true`, or
`source.metadataVerified: false` do not match explicit filters. Search does not
infer scope from paths, titles, prose, or a source-map row. Existing records may
lack these fields, so a strict filter can return no results. Search does not
silently relax filters. It checks filters before limiting search candidates and
again after choosing a copy representative.

Results include `retrieval` with intent, explicit filters, a reason, and scope
limits, even when no record matches. Context includes these choices when space
permits and gives each record a ranking reason. Explanations and citations share
the existing context budget. Exact CLI search needs no embedding model. Routing
does not change repository isolation, copy grouping, conflicting claims, scoped
supported supersession, or private evidence rules.

## Query gaps

The console captures private query observations and checks completed queries
on a persistent schedule. Checks default to every six hours, at most twice per
day within the existing learning budget. View the schedule and confirmed gaps
in Background jobs; no command is required. `tb knowledge gaps` reports signals
and checked assessments;
`gap-review --file review.json` records a diagnosis, and `gap-work GROUP_KEY`
creates a focused work request and an incomplete evaluation draft. Scheduled
checks also create these drafts and send checked source excerpts through the
existing learning flow. Maintenance reruns confirmed gaps, records retrieval-only
resolutions, and generates private answers when budget permits. Review saved
answers in Background jobs; no command is required. Full ingestion passes remain disabled. See
[knowledge-query-gaps.md](knowledge-query-gaps.md) for
privacy, retention, review fields, and resolution through a checked evaluation.

## Evidence before code edits

The shared repository's `CODE-EVIDENCE.md` defines a standalone workflow. Read
and search Markdown with ordinary file tools and inspect examples with Git.
The console is optional. The shared repository holds the workflow and knowledge;
execution and enforcement code stays in this console repository.

For Git tasks through `createGraphCodexAppServer`, preparation runs read-only.
The assistant supplies exact source paths, scoped instruction or knowledge
quotations, and current local examples pinned to Git revisions. The host checks
those citations. A separate read-only conversation assesses their scope before
writing permissions are granted. Missing support or conflicts stop the task.

After writing, the host compares Git-visible files with the pre-edit state,
rejects paths outside the approved record, and asks the independent checker to
assess the actual changes. Failed or interrupted checks retain edits and do not
return a verified result. A follow-up during this process invalidates the record
and stops the active turn. Resume with the updated request and a new record.
Successful writing results include `codeEvidence` and capture the assessment.

This checks Git-visible source, including pre-existing dirty files. It does not
restrict every filesystem write or external tool. Ignored build output is outside
the comparison. Writing permissions use the runner's existing configured policy.
The independent assessment uses model judgment and can be wrong. Tasks outside
this runner do not acquire this enforcement merely by reading the instructions.
Read-only tasks cannot run checks that need writable output; use an authorized
validation runner or report that limit. Non-Git tasks remain read-only here.

A direct human instruction is required to change deliberate guidance. A source
pattern, assistant note, or `source.status: instruction` label alone is not proof
of that authorization. Keep automatic learning separate from deliberate rules.

## Keep recovery data out of retrieval

Use `tb knowledge clean` to inspect the current cleanup policy and candidates.
Use `tb knowledge clean --apply` to remove their derived search sections and
vectors and skip pending learning jobs. The command keeps the original records,
IDs, lesson dependencies, and study coverage. Use `tb knowledge show RECORD_ID`
for an explicit read of retained evidence.

Cleanup selects recognized recovery and checkpoint types, JSON browser captures
with a nonempty DOM snapshot, and the two checked parser-inventory studies
`architecture-study-20261013` and `architecture-relationships-20261013`. It does
not classify records by size or folder. Lessons, task outcomes, ordinary source
evidence, and focused behavior studies remain searchable. Full inventories remain
available for explicit source navigation. The policy lives in
`commands/knowledge/retrieval-policy.mjs`.

The scan uses a fixed record-row cutoff and bounded transactions. To limit a run,
pass `--batches N`. Resume with the returned `--after-rowid` and `--through-rowid`
values. A fresh run includes later records. Rowids are local scan cursors and must
not be reused after rebuilding the database from scratch. New records follow the
same policy before indexing; older running console processes need a restart to
load updated code.

The local `retrieval_archives` table is a disposable selection cache. Cleanup does
not change immutable source files or physically shrink the SQLite file. Freed
pages can be reused by later writes. Keep raw capture blobs once and let recovery
manifests refer to existing evidence IDs, instead of embedding another copy.
