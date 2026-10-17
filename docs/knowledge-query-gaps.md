# Learn from query gaps

The console records bounded private query observations in its local SQLite database.
Each observation retains the question, repository, source revision when known,
changed paths, explicit filters, returned record IDs, actual search mode, and
source applicability checks. Console turns attach their status and private task
evidence ID to the exact observation. CLI searches also record observations;
they do not assert a source checkout revision when none was checked.

These diagnostics are separate from knowledge records, search, embeddings,
automatic learning, publication, and Git sync. They cannot answer their own queries.
The most recent 1,000 observations are retained. Ordinary rebuilds preserve them;
deleting the database loses them. Reports and work drafts contain private questions.
Keep them outside the shared knowledge repository.

## Scheduled checks

No command is needed for normal operation. Console maintenance checks completed
queries automatically. The default interval is six hours, with at most two checks
per UTC day, within the existing total daily learning budget. A query must be at
least five minutes old. The schedule, usage, retry state, and checked work survive
restarts while the local database remains. Only one check runs at a time across
console processes.

The checker runs a bounded, read-only AI task in the recorded source checkout. It
compares the question, task evidence, and current retrieval. Confirmation requires
a current source quote that the console independently matches against Git. A
dismissal also needs a checked source or retained evidence quote. Unsupported
output never confirms a gap. Quotes establish source accuracy; the assessment
remains an interpretation and does not prove runtime behavior or test results.

Confirmed gaps create focused work requests and evaluation drafts automatically.
For missing evidence, exceptions, or stale evidence, checked source excerpts enter
the existing learning flow. Their visibility follows `shareRepositories`; private
questions, task transcripts, and assessments remain local. The checker does not
start a full ingestion pass, change source code, or mark an evaluation passed.

Open **Background jobs** in the console to see the schedule, pending query count,
latest result, and confirmed gaps. Quiet maintenance ticks make no repeated model
calls. Failed and insufficient checks retry after their schedule and backoff allow
it. An exhausted budget postpones checks. The console must be running; when it
starts again, overdue checks resume without running every missed interval.

Optional settings under `ai.knowledge.queryGaps` are `enabled`, `intervalMs`,
`minAgeMs`, `maxCallsPerDay`, and `retryMs`. The defaults are enabled, 21,600,000,
300,000, 2, and 3,600,000 respectively. Turn off scheduling with `enabled: false`.

## Inspect or review manually

```sh
tb knowledge gaps --repository thunderbird
tb knowledge gaps --repository thunderbird --all
```

The default report includes queries with no returned results, lesson source files
that changed, and reviewed groups. These are signals, not established failures.
A successful task does not prove retrieval was sufficient. A query with results
can still miss a rule or exception; use `--all` to inspect it.
Repeated questions group by normalized wording, repository, source revision,
and explicit filters. Ranking favors confirmed gaps and repeated groups.
A review records the exact observation checked; compare its `observationId` with
the latest observation before assuming the same diagnosis still applies.

Read the original sources and retained turn evidence before reviewing a gap.
Distinguish missing evidence from indexing, ranking, wrong scope, a missing
exception, stale evidence, or misuse of evidence in an answer. A score threshold does not confirm a failure. Scheduled assessments require
checked source excerpts; the interpretation still needs an evaluation.

Save a checked review JSON file locally:

```json
{
  "observationId": "ID from the report",
  "state": "confirmed",
  "reason": "missing-evidence",
  "explanation": "The index lacks the checked caller contract.",
  "checkedBy": "Name of the person or agent that checked the source",
  "verification": "Exact source revision, paths, and checks performed",
  "evidenceIds": []
}
```

```sh
tb knowledge gap-review --file /absolute/path/to/review.json
tb knowledge gap-work GROUP_KEY
```

Valid reasons are `missing-evidence`, `indexing`, `ranking`, `wrong-scope`,
`missing-exception`, `stale-evidence`, and `answer-misuse`. Evidence IDs, when
provided, must exist in the same repository. Empty IDs are allowed for absent
evidence, but the source check must still be stated in `verification`.
Reviews are supplied checked assessments; the tool validates their structure
and source IDs, not the truth of their explanations.

## Automatic evaluations and answer review

Maintenance consumes confirmed work without a command. It verifies the source
anchors again, checks that the source files still match the checked revision,
and reruns the original query with its recorded filters, search mode, model,
result limit, and context budget. Hybrid search remains unavailable when its
original model is unavailable; it is not replaced with exact search.

A retrieval check passes only when every required original-source excerpt fits
in the selected context and all returned records match the repository and
explicit scope. A parent record ID alone cannot replace its required excerpt.
Retrieval gaps can close automatically when the complete original query was
retained and the required excerpts were absent from the original context.
The saved resolution explicitly covers evidence retrieval. Old observations
without the original query cannot claim this automatic resolution.

The worker creates a private evaluation case and saves the actual context,
record IDs, search trace, source revision, answer digest, and available code
fingerprint. The default code fingerprint identifies the loaded search and
feedback entry-point functions; it is not a hash of every dependency. Source
excerpts are checked facts about source identity. Their semantic meaning and
whether they cover every part of the question still need review.

When evidence retrieval passes and the shared daily budget permits, the console
provider generates an answer from the question and returned context. Generation
does not receive expected facts, prohibited claims, or review scores. The answer
is private evaluation data and never enters knowledge search, learning, or Git
sync. Missing or unknown citations cannot receive a passing review. Scheduled
runs wait for budget and back off after missing models, source changes, or errors.

The provider then reviews the exact saved answer against its supplied context and
original sources at the checked revision. It checks all five quality dimensions,
every required fact and every prohibited claim. Quotes in the review must match
original source text. The result states that an assistant performed the review;
no human review is required. Generation and review each consume one daily model
call. When review must wait for budget, a later run reviews the saved answer
without generating it again.

Open **Background jobs** to inspect the saved answer and review. Missing-exception
and answer-misuse gaps stay open unless source review passes. A failed review
remains visible. The console shows the scores and fact checks. It has no required
review form.

The tool validates source identity, exact quotes, citations and review structure.
The assistant still makes the semantic judgment. Its reasons, source excerpts,
reviewer kind and answer digest remain available for inspection. Checked source
excerpts can enter the existing cited learning/publication flow, but evaluation
keys and private questions cannot.

Full automatic ingestion passes remain disabled. Scheduled source checks provide
private capture, grouped reports, checked diagnoses, eligible source evidence,
focused work requests, and evaluation drafts. Retrieval-only resolutions and reviewed-answer resolutions have separate scopes.
