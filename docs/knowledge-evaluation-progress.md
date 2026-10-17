# Knowledge evaluation improvements

Checked on October 13, 2026. These results extend the
[initial bounded baseline](knowledge-evaluation-baseline.md). They measure
retrieval and answer quality separately.

## Query cost and ranking

Exact search now ranks and limits text matches before loading section bodies.
The isolated SQL profile used the natural Calendar scheduler question against
51,394 records and 1,104,343 sections. The former query exceeded its 30-second
limit. The new query completed in 1,020 milliseconds. Each process had its own
read snapshot and cache state. This is a query measurement, not a precise speed
ratio or total answer latency. Candidate-order tests preserve the original
`bm25()` scoring and apply explicit scope before the candidate limit.

Retrieval traces now identify query stages, matched sections, source families,
ranking and reasons for exclusion. Missing original sources differ from sources
lost to candidate limits, scope, duplicate claims or the context budget.
Replacement decisions and snapshot record counts are cached. Legacy vector
matches are ordered by similarity and capped, rather than all receiving the same
score. Task transcripts remain searchable, with a lower weight that favors
original evidence.

## Full-index results

Both completed runs used the same 63,617-record corpus digest:
`1ef954aa3099bd2aab977e5b99249e4669e19b7a11d6af5d2eb7408c05b09314`.
Configuration: 29 questions, top-k 10, 10,000-character context budget, natural
question used verbatim.

| Measure | Exact | Hybrid with legacy vectors |
| --- | ---: | ---: |
| Cases with every required source | 12/29 | 8/29 |
| Mean evidence recall | 53.4% | 34.5% |
| Strict fixture precision | 18.9% | 8.1% |
| Mean reciprocal rank | 0.506 | 0.231 |
| Mean nDCG | 0.467 | 0.244 |
| Repository scope errors | 0 | 0 |

The hybrid snapshot had 2,053,843 sections, zero section vectors and 48,321 old
record vectors. It measures the legacy fallback. It cannot establish the quality
of a fully indexed section model. New reports label semantic coverage and
fingerprint stored vectors. Orphan vectors do not count as usable coverage.

Within the exact run, reducing task-transcript weight raised complete source
coverage from 11/29 to 12/29. `test-pref` became complete; `freshness` gained partial
coverage. No case lost recall. The matched hybrid comparison stayed at 8/29.
An optional common-word filter lost three required-source cases in the public
exact set, so the shipped default keeps all existing query terms.

The reports retain exact code hashes. Their `changedDuringRun` flag is true
because files in the knowledge implementation changed during the runs. These
are completed diagnostic results, not a fully frozen code release comparison.
The earlier 319-record baseline uses a smaller corpus and must not be used as a
direct before/after comparison with these full-library runs.

## Semantic indexing and answer review

The regular indexing command now counts pending sections and reports partial or
complete coverage. A real local-model smoke check used one synthetic record with
75 sections in an isolated cache. A one-batch run indexed 32 sections and reported
43 remaining. The next run indexed all 43 and reported complete coverage.
Batch progress estimates avoid repeated full-table counts; final counts are exact.
Malformed or stalled embedding batches cannot claim completion.

Answer generation receives the question, repository, explicit filters and actual
retrieved context. Expected facts and lookup paths stay out of that prompt.
Automatic source review runs separately. It receives the saved answer, its exact
context, the rubric and original sources at pinned revisions. Every required fact
and prohibited claim needs a verdict and reason. Review quotes must occur in the
supplied source. A passing result requires full scores in all five dimensions,
supported facts and no prohibited claim. The report records the assistant's
identity, source text, source digest and exact answer digest. No human review is
required.

Background query-gap evaluations use the same source review within the existing
daily model-call budget. If generation uses the last available call, the next
budget window reviews the saved answer without generating another answer.
Failed reviews remain visible. Retrieval-only and answer-review resolutions
retain separate scopes.

Four real answers used the configured `gpt-6.1-sol` model at low reasoning effort
and the pinned public corpus. All four now have assistant source reviews. None
met every strict fixture requirement. The Calendar answer honestly states its
missing evidence; it receives full credit for correctness and uncertainty, but
no completeness credit. The equality answer misses current guide checks. The
regression answer avoids inventing a cause, but omits parts of the requested
diagnosis. The browser answer states the correct boundary, but omits the fixture's
additional `iab` condition. That condition is not explicit in the natural question;
this fixture limit is recorded in the audit. These four selected cases are not a
representative answer-accuracy percentage.

The first automated Calendar review incorrectly treated reviewer-only evidence
as evidence the answering model had received. The review instructions now keep
those evidence sets separate, and a real recheck gave the honest limitation full
credit. Original answers and earlier reviews are preserved alongside the final
review. The active workflow requires no human quality review.

Focused and related knowledge/background checks passed: 120 tests, including
automatic-review budget resumption and browser display. ESLint and diff checks
passed. Changes remain uncommitted; unrelated checkout changes were preserved.

## Remaining evidence gaps

Seven cases still lack original implementation or landed-code evidence in the
evaluated full corpus: `calendar-scheduler`, `calendar-break`, `calendar-memory`,
`calendar-alarm`, `async-body`, `print-dialog-reason` and
`unified-folder-regression`. Navigation maps do not satisfy those requirements.
Existing source/history scans can supply this evidence; no duplicate scan was
started for these evaluations.

The saved answer samples also show that retrieving a guide record can select the
wrong section. The equality answer relies on an older provisional suggestion
because its context includes only the current guide introduction. Section-level
support and better selection of multiple relevant excerpts remain priorities.

Full section-vector coverage and a new stable full-library comparison remain to
be done after the active scans settle. Freshness and coverage statements here
apply to the recorded snapshots, not every later ingestion result. Private
contexts and answers stay in the local evaluation result directory and never
enter knowledge learning or publication.
