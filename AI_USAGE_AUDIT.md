# AI usage and checkout audit

Audit date: 2026-09-28. The console remained stopped during this audit.

| Feature | What starts AI | Context and retry behavior | Checkout ownership |
| --- | --- | --- | --- |
| Review | Open a review or send feedback | Initial review retains full coverage. Follow-ups reuse the saved chat and inspect affected findings. Large previous reports remain in complete local files. One bounded response-format repair is retained. | Initial review and follow-ups share the Review checkout queue. A changed HEAD blocks stale follow-up work. |
| Review Update and Verify | Start or resume the requested assessment; act on a finding | Existing prompt compaction remains. A missing chat may be replaced once. A busy writer never causes a replacement chat. | Active work owns the working checkout. Other sessions cannot change it. |
| Update | Send a user instruction | Complete conversation and project context remain available in a local file when large. Follow-ups reuse the chat and do not repeat unchanged investigation. | Shares the working checkout guard with Review Update and Verify. |
| Conflict resolution | Explicit AI resolution action | Large saved file snapshots stay out of the starting prompt. The agent reads conflict ranges and relevant context. It still returns only changed ranges. No automatic model retry loop. | Read-only proposal, one pending resolver per rebase; exact source/index snapshots are checked before changes are accepted. |
| Implement | Explicit start; saved workflow stages | Medium reasoning. Implementation and verification keep separate saved chats. Large bug/report context is referenced from disk. Existing stalled-finding checks remain. Additional Codex agents are not requested. Required CodeRabbit verification remains. | Reserves the working checkout across the workflow, including Git steps. Cancellation keeps ownership until the active operation exits. |
| Try | Latest attempt for a patch is complete and failed | Compact evidence index, separate job/log files, same assessment chat on retries. Known verdicts are reused. Failed or unresolved assessments may retry. Four concurrent workflows remain supported. | Diagnosis and repair use paired Gecko/comm worktrees per workflow. Assessment is read-only at the tested commit. Each workflow has a durable lock. |

Try status polling, historical runs, incomplete attempts, passing attempts, and
submission recovery do not start AI. A newer attempt supersedes older work; the
monitor checks again after evidence collection and before starting an agent.
AI verdicts still require evidence. Uncertainty is not converted into a pass.

All direct AI calls in `commands` and `lib` route through the five entry modules
covered above. `ai-writing.mjs` contains prompt rules, not another AI caller.
Build operations, dashboard reads, and status polls do not independently call AI.

## Validation

- Synthetic Try evidence includes 30 failures with large logs. The starting prompt
  stays under 5,000 characters. All failures, suggestions, and log contents remain
  available on disk. This measures prompt size, not allowance charged.
- Real temporary Git repositories confirm concurrent Try assessments use distinct
  checkouts at the tested revision and do not read the author's uncommitted edits.
- Tests confirm saved Try chat reuse, latest-attempt gating, and suppression when
  a newer Try appears during evidence collection.
- Tests confirm same-checkout Review follow-ups queue, independent Review checkouts
  can proceed together, and failures release the queue.
- Tests confirm an older Update session cannot start edits during another task,
  and Implement sends medium reasoning to the model.
- AI responses are mocked. No paid end-to-end agent run was started. Actual allowance
  savings still need observation after the console is deliberately restarted.

These checkout guards coordinate this console's tasks. They do not lock out an
unrelated terminal, editor, or independently started tool. Snapshot and HEAD checks
remain necessary. Starting multiple independent consoles on the same checkout is
not covered by the in-process Review queue.


## Follow-up audit: 2026-09-29

This is a read-only review of application behavior and saved Codex sessions. No
new AI worker was started. No application code or running workflow was changed.

### Measured sample

Matched saved Try, Implement, and patch-session chat IDs to local active and
archived rollout files. Do not rely on originator alone: some console chats now
say `Codex Desktop`, while older ones say `tb-tools`. Do not use rollout filenames
as UTC event dates: filenames use local dates in this sample.

The bounded sample below contains 11 saved chats whose first recorded token usage
was on September 29 after 04:00 UTC (midnight America/New_York). It is not a full
account total. Values are snapshots collected around 23:05 UTC; active chats can
continue to grow. Count the last cumulative usage record once per chat. Cached
input is part of input, and reasoning output is part of output.

| Recorded metric | Tokens |
| --- | ---: |
| Input | 17,183,142 |
| Cached input, included above | 16,162,944 |
| Input minus cached input | 1,020,198 |
| Output | 123,676 |

These counters do not establish how much subscription allowance was charged.
The cache share is about 94%. Input growth is confirmed; its exact allowance cost
is not. OpenAI documents separate cache measurements in its
[prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

### Findings

1. **File-backed context still becomes large model input.** In Try assessment
   `01a0ee6b-d56d-7790-adf8-7457a2394503`, the task prompt was 3,168 characters.
   The first model request used 20,938 input tokens; the peak request used
   161,574. Thirty tool calls returned about 448,330 characters. Several outputs
   were about 42,000 characters each. They printed evidence indices, error
   summaries and source. A small initial prompt does not bound the whole session.

2. **Related-repair context is broad and repeated.**
   `getRelatedTryRepairs` in `commands/graph/try-repair-coordination.mjs` selects
   workers from the same checkout and includes their assessments, reports and
   every run's assessment. It does not first filter by shared error or affected
   files. One current repair context contains 162,126 characters of related work
   from three workers, compared with 11,750 characters for its own assessment.
   The repair prompt asks the worker to inspect ALL related repairs. Actual tool
   calls printed these reports and histories.

3. **Usage-limit retries grow chat history.** Assessment chats
   `01a0eee9-113d-7691-98ad-15d1f8d6d70f` and
   `01a0ef06-c566-7492-b5df-c7f7e8b237d1` contain nine and eight copies of the
   3,954-character assessment prompt. Their final attempt produced the recorded
   assessment usage. Earlier turns completed with `usage_limit_exceeded` and no
   token-usage result. The error supplied a reset time, but the monitor retried.
   This proves duplicate prompt accumulation, not that rejected turns themselves
   consumed paid inference. Another repair chat received three copies of its full
   task prompt plus a response-format correction.

4. **The new 50-push comparison can amplify this problem.** Current code scans
   50 pushes in each of three repositories and includes all jobs in the evidence
   index. Older indices already reach 38,104 bytes with only 15 comparison pushes.
   The larger search is required; the larger model input is not. No sampled run
   proves the cost of the new 50-push code yet.

5. **The console does not save per-turn usage counters.** Its previous test only
   checked initial prompt length. The app-server provides
   [`thread/tokenUsage/updated`](https://learn.chatgpt.com/docs/app-server), but
   the console does not retain those counters as workflow measurements.

### Recommended changes, in order

- Search the 50 pushes in code. Group matching error signatures before calling
  AI. Give AI a compact list of distinct unresolved errors, matching existing
  errors, affected job IDs and evidence links. Keep full logs available on disk.
- Put related-worker details in separate files. Start with a compact list of
  patch IDs, changed files, error signatures, repair hashes and report paths.
  Read full reports only when they match the current work.
- Handle `usage_limit_exceeded` explicitly. Wait for its reset or a user resume;
  do not append another full prompt on each timer tick.
- Resume repair with the remaining issue and new evidence, rather than another
  copy of the full task and all prior reports.
- Save per-turn input, cached input and output counters. Compare full-session
  growth before and after these changes. Keep tool-output reads bounded without
  dropping evidence or reducing required review coverage.

The first two changes address observed context growth. The retry change removes
confirmed duplicate input. Expected savings are not yet measured.


## Data gathering that should run without an AI agent

Follow-up source review: 2026-09-29. This section recommends changes; it does not
claim they are implemented. Use service APIs where supported and local code for
Git, parsing, caching and process control. Preserve authenticated browser
extraction for Phabricator fields that APIs do not provide.

| Priority | Work now left to an agent | Console-owned replacement | Work that stays with AI |
| --- | --- | --- | --- |
| 1 | Parse many Try error summaries, compare jobs and reconstruct Taskcluster metadata | Parse logs once; group signatures; search the requested 50 pushes; return matching evidence and unresolved groups with all affected job IDs | Judge ambiguous matches and diagnose unresolved failures |
| 1 | Re-read Phabricator pages after the console supplies discussion and raw patches | Reuse the existing structured review snapshot, diff ID and exact anchors; refresh once when remote state changes; fetch missing fields through the existing API/browser reader | Assess comments, patch intent, source behavior and code suggestions |
| 1 | Read all other repair workers' reports and attempt histories | Select candidate workers in code using stack relationships, touched files and error signatures; provide compact records and separate detail paths | Decide whether a candidate repair applies or conflicts |
| 2 | Find linked Bugzilla context and retrieve comments again | Extract bug IDs and explicit links; batch bug metadata; fetch and cache comments and attachment metadata; expose an index and changed records | Interpret requirements and decide which dependencies matter |
| 2 | Find known planning documents repeatedly | Resolve explicit document links and known project paths once; store source/version and sections in a document index; use an available supported document API | Interpret acceptance criteria and reconcile conflicting requirements |
| 2 | Collect Git status, parents, stack, changed files, diffs and descendant refs | Produce one revision-bound manifest using Git commands; keep diff bodies in files and provide paths; refresh mutable status before writes | Trace source behavior, inspect relevant history/blame and choose fixes |
| 2 | Rediscover conflict ranges and read all three Git stages | Extract numbered conflict ranges, nearby lines and base/ours/theirs object IDs before starting the resolver; retain full snapshots for validation | Resolve the meaning of conflicting edits |
| 2 | Launch and poll CodeRabbit, builds and selected tests | Run processes through the console; save complete output; deliver exit status, findings and failure excerpts; cache only under an appropriate source/configuration key | Select additional tests, evaluate findings and repair code |
| 3 | Read every prior report to discover which findings remain open | Maintain structured finding IDs, current status, source revision, test receipts and links to prior evidence; send only changes on continuation | Reassess disputed findings and determine whether evidence still applies |

### Confirmed source locations

- `commands/graph/ai-writing.mjs`: `PHABRICATOR_WEB_CONTEXT` asks the agent to
  inspect the full patch and discussion in the authenticated browser. This is
  included in Review, Update and Verify prompts. The replacement should use
  already captured data first, not bypass the established authenticated reader.
- `commands/graph/reviews.mjs`: `getGraphCommitReview` already supports structured
  web snapshots and API transaction, author and inline-comment retrieval.
- `commands/graph/phab-web-review.mjs`: `readWebReview` already extracts structured
  discussion and native suggestions. Browser extraction need not use an AI turn.
- `commands/graph/implement.mjs`: preparation already retrieves the main bug,
  comments and attachment metadata without AI. Keep that behavior. The prompt
  still delegates linked context and planning-document discovery to the agent.
- `lib/bugzilla.mjs`: batch bug lookup, comments, attachments and history helpers
  already exist. Reuse these rather than asking the agent to issue ad hoc requests.
- `commands/graph/patch-review.mjs`: raw patch, SHA-256, checkout revision and stack
  context are already prepared. Extend this pattern across the other workflows.
- `commands/graph/rebase-resolution.mjs`: snapshots already capture the full index
  and conflict files; numbered conflict ranges can be derived from this data.
- `commands/graph/patch-update.mjs`: Verify delegates launching CodeRabbit and
  focused validation to the agent. Keep independent review, but move process
  execution and output collection to the console.
- `commands/graph/try-repair-coordination.mjs`: related-worker selection currently
  uses the same checkout and workflow state, then includes full reports and runs.
- `commands/graph/implement.mjs`: every continuation includes the accumulated
  reports array. Keep complete reports on disk; build a current-findings view.

In the same 11-chat sample, tool-call text matched Git inventory commands 125
times, evidence/JSON parsing 148 times, remote-data access 18 times, and process
control or build/test commands 32 times. These categories overlap, include mixed
calls, and do not measure avoidable tokens. They identify places to investigate,
not commands to remove blindly.

Do not replace careful review with a short generic summary. Keep exact source,
all required review coverage and full evidence available. The change is to make
the console gather and index facts once, while AI reads the relevant facts and
makes decisions. Do not send a large API response directly to the model: extract
stable IDs, necessary fields, changes and evidence paths first.


## Changes implemented after the follow-up audit

- Try evidence now has an index of distinct error signatures and exact matches
  across the full requested comparison set. The console parses complete local
  logs and groups matching jobs. The first index links signature groups and the
  full comparison index instead of embedding every baseline job. Matching is
  evidence for the assessor, not a new automatic verdict rule. Errors that the
  parser does not recognize remain available in the full job logs.
- Related-repair context now lists worker IDs, current hashes, changed files,
  failure IDs and detail-file paths. Full reports and run histories stay in
  separate files. Agents are told to open only relevant details.
- Implement sends report indexes instead of all report bodies. It batches linked
  Bugzilla metadata for dependency IDs and explicit comment links before AI starts.
  Main bug comments are still available in full. Linked-comment and document
  retrieval are not yet fully moved into console code.
- Implement and Try receive console-generated Git metadata and a saved patch.
  Mutable status must still be refreshed before edits.
- Conflict resolution receives numbered conflict ranges and nearby lines, with
  full snapshots available separately. Existing validation still checks the full
  files and index before applying edits.
- Review, Update and Verify now use the supplied Phabricator snapshot first.
  Browser reads are for missing fields or changed remote data, not duplicate
  collection. Full review coverage and exact anchors remain required.
- Try usage-limit failures persist a reset block. Timer ticks and restarts do not
  resubmit the same task before the reset. Without a usable reset time, automatic
  retries stop for that attempt. A new attempt has no inherited usage block.
- App-server calls with usage events save thread/turn IDs, task, selected model,
  effort, prompt length and reported token counters in
  `~/.tb-tools/ai-usage.jsonl`. No prompt or source contents are logged. Reported
  totals are cumulative per thread; do not sum those snapshots as turn costs.

### Model and reasoning policy

Settings stores a model and reasoning level per task in `~/.tb-tools/ai-settings.json`.
Defaults use GPT-6 Sol. The catalog is checked before saving and running each
choice. Unavailable models or unsupported effort values stop the task without
a silent fallback. Changes apply to the next turn, including resumed work.

| Work | Preferred model | Effort |
| --- | --- | --- |
| Applying a bounded review edit | GPT-6 Sol | Medium |
| Ordinary conflict batch | GPT-6 Sol | Medium |
| Unmarked conflicts, more than three files or 200 context lines | GPT-6 Sol | High |
| Full review, Verify and open-ended Update | GPT-6 Sol | High |
| Implement | GPT-6 Sol | Medium |
| Initial Try diagnosis | GPT-6 Sol | Medium |
| Try repair and unresolved diagnosis | GPT-6 Sol | High |

The user requested Sol for all console work to conserve usage this week.
Existing reasoning settings are unchanged.
[OpenAI model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection)
informs the policy; these local task assignments still need live quality and usage
measurement. Known test requirements and checkout guards are unchanged.

CodeRabbit execution, general build/test process control and planning-document
retrieval remain with the agent in this change. They are candidates for a later
change that preserves the current source/build and independent-review contracts.


Validation of this change: focused unit and integration suites passed, including
120 tests in the main implementation/monitor/model/context group and 48 tests in
the follow-up prompt/Verify/browser/evidence group (groups overlap). Additional
checks passed for conflict excerpts and exact Git diff whitespace. ESLint and
`git diff --check` passed. AI calls were mocked; no paid inference, live savings
measurement or model-quality comparison was performed. The running console and
active workers were not restarted.
