# Initial knowledge evaluation baseline

Checked on October 13, 2026. This is a retrieval baseline on a bounded public
corpus. It is not a generated-answer score or a full-library ranking result.

See [the follow-up results](knowledge-evaluation-progress.md) for the query fix,
completed full-index runs, and automatic source reviews of generated answers.

The suite has 29 questions and 63 verified source anchors. The pinned corpus has
64 notes and their available record dependencies: 319 records and 1,001 sections.
Both runs use the same corpus digest, fixture, and search code file hashes.

| Measure | Exact | Hybrid |
| --- | ---: | ---: |
| Cases with every required source | 19/29 | 19/29 |
| Mean evidence recall | 75.9% | 77.6% |
| Strict fixture precision | 25.5% | 26.0% |
| Mean reciprocal rank | 0.520 | 0.695 |
| Mean nDCG | 0.556 | 0.666 |
| Repository scope errors | 0 | 0 |

Configuration: top-k 10, context budget 10,000 characters, natural question used
verbatim. Hybrid uses Xenova/all-MiniLM-L6-v2, q8 CPU inference, mean pooling,
normalized vectors and all 1,001 section vectors. No model substitution occurred.
Node: v26.3.1. The answer adapter was tested with a stub provider; no
provider-based answer quality run or human answer review is claimed.

Code HEAD: e73e2bdb18e9703a88702c911643531a4eb376c8. The checkout has uncommitted changes; the local
JSON reports contain exact file hashes and dirty state.
Knowledge manifest revision: a1e73d5d03ed324d86f87d6a5d9d1d02eebcc5d5.
Corpus digest: 697e37b7bb94946148d9f01e63d53738d87a9d422d76dd919133478ff2cf1070.
Thunderbird source: 87d0159c7149a43253964c2cb6917939557dc799, plus the exact
older commits recorded in the two change-reason and regression cases.

## Missing sources and ranking failures

These seven cases lack their required original contract or landed-code evidence
in the selected corpus:

- calendar-scheduler
- calendar-break
- calendar-memory
- calendar-alarm
- async-body
- print-dialog-reason
- unified-folder-regression

The checked Git source anchors are available for audit. That does not make the
original code a retrieved knowledge record. Navigation maps do not fill this gap.
Do not reduce these requirements to make the baseline pass.

Exact search also misses available expected sources for named-tasks,
unknown-regression, and freshness. Hybrid misses available expected sources for
named-tasks, iterator-snapshot, and freshness. Hybrid gains the unknown-regression
reference but loses a source in iterator-snapshot. Improved mean ranking does not
mean every case improves. A missing reference in an uncertainty case does not by
itself prove that an answer would be wrong; answer quality is evaluated separately.

## Full-index limits

Cold full-checkout import produced a multi-gigabyte evaluation cache before it was
interrupted. Separate read-only full-index attempts, at about 51,000 records,
remained on their first question after several minutes of total runtime and were
interrupted. Their snapshots differed while scans were active. No completed
full-index retrieval score or precise query timeout is claimed. The local attempt
report preserves this limit. This is evidence to investigate index size and query
cost before scheduling whole-library runs.

## Next checks

- Check the large section index and natural-question query cost. Keep the original
  expectations and rerun the full library when the scan/index state is stable.
- Add original public code and landed-patch evidence through the existing scans.
  Do not launch duplicate history or relationship scans.
- Inspect the returned sections for named-tasks, freshness, and iterator-snapshot.
  Distinguish candidate ranking from context-budget exclusion.
- Add more independently checked public review rejection and cross-component
  regression cases. The current set is concentrated on iteration and scoped rules.
- Run a configured answer provider, then apply source review with the five-part rubric
  against original evidence. Source recall is not semantic answer correctness.

See [the runner and rubric](knowledge-evaluation.md) for commands. Complete JSON
reports, returned contexts, source manifests, and the interrupted full-index
observations stay in the user's local evaluation result directory. They can
contain private source paths and must not enter learning or shared evidence.
