# Evaluate knowledge retrieval and answers

The evaluation runner uses `searchKnowledge`, the same selection and context
assembly used by the console and knowledge CLI. It does not use a second search
implementation. It scores the evidence that actually fits in the returned context.
The natural question is the search query. Default retrieval keeps its existing terms. Expected facts never expand the query.

Run from tb-tools with a supported Node runtime:

```sh
node commands/knowledge/evaluation-cli.mjs \
  --repository-directory /path/to/thunderbird-knowledge \
  --source-directory /path/to/comm \
  --corpus test/fixtures/knowledge-evaluation/public-corpus.json \
  --top-k 10 --max-chars 10000 --mode exact \
  --output /path/to/local-results/exact.json
```

For a baseline against an existing live index, add
`--index-source /path/to/local-cache/index.sqlite`. The runner opens the source
read-only, pins a read transaction, and keeps a consistent
SQLite read snapshot for the run. It searches that snapshot without importing the checkout again.
The report labels this origin. Its record digest identifies the actual indexed
corpus; the shared checkout revision is only a reference and does not prove that
all of that revision is indexed. Private records can be present in this mode, so
keep reports local. Snapshot mode preserves existing vector coverage and reports
that coverage instead of claiming a fresh full semantic index.

`--corpus` loads the pinned public manifest through ordinary note parsing and
record validation, then indexes it with the production store. This bounded corpus
contains required notes, 64 notes in total, and available record dependencies.
It includes distractors. It does not measure ranking across the whole library.
Its exact blob manifest makes the initial baseline repeatable while history and
section scans continue. Omit `--corpus` to import the full shared checkout.

The initial public fixture is `test/fixtures/knowledge-evaluation/questions.json`.
It contains 29 questions, exact note IDs, portable source anchors, source revisions,
required facts, prohibited claims, and verification limits. The runner checks each
anchor against its Git revision before retrieval. This verifies source identity
and checked excerpts, not the meaning of every expected fact.

The set emphasizes checked iteration contracts, test and style scope, historical
review uncertainty, and console versus Thunderbird browser checks. It is an
initial set, not representative coverage of all Thunderbird components. In
particular, independently verified public change reasons, real regression fixes,
and accepted/rejected review alternatives need more cases after history scans
finish. Existing provisional review accounts test uncertainty; they do not stand
in for verified acceptance. Do not lower expectations to improve the baseline.

## Retrieval measurements

Each case has independent evidence requirements. A requirement can list verified
alternate record IDs or original-source anchors. An anchor requirement matches
only a retained `code-snapshot`, `git-file`, `landed-patch`, or `git-commit` with the exact revision, path, and
checked excerpts. A source map is not behavioral contract evidence.

- Recall: fraction of evidence requirements present in selected context.
- Precision: fraction of unique returned claims that match an expected requirement.
  This is a strict fixture measure; unlisted useful evidence can lower precision.
- Reciprocal rank: one divided by the first relevant claim's position.
- nDCG: discounted gain by position, compared with ideal required-evidence order.
  Each requirement receives credit once. This measures ranking, not truth.
- Complete: every required evidence group was found.
- Scope errors: returned records from the wrong repository.
- Duplicate claims: returned mirrors of the same claim, using production claim grouping.
- Missing evidence: missing requirements, with a distinction between sources absent
  from the corpus and sources available but not selected.

Explicit `filters` in a case are passed through to the production pipeline.
Repository checks are deterministic. Component, language and role correctness also
need source-based context review when source metadata is absent or uncertain. Recall
of a large note does not prove that its returned section contains the needed fact.
Review the saved context before treating retrieval as adequate for an answer.

Use different top-k and character budgets as separate runs. The real pipeline caps
context at 24,000 characters. The report records query settings, code file hashes,
Git revisions and dirty state, fixture digest, corpus record digest, returned
contexts, coverage by intent, failures, and availability gaps. Code hashes matter
when concurrent uncommitted retrieval changes are present. Record ordering and age
ranking are production behavior; compare runs against the same corpus and date.

The default cache is a new local temporary directory. `--cache` can retain a
separate evaluation cache. The runner refuses a nonempty cache without its marker. Full-checkout caches
reject reuse after the corpus revision or dirty state changes. Pinned public-corpus
caches use the manifest digest, so unrelated checkout additions do not invalidate them. Do not use the
live knowledge cache. Results and caches must remain outside the shared checkout.
The corpus digest is the definitive record snapshot; changed untracked content can
require a fresh cache even when Git status text stays the same.

## Semantic search

```sh
node commands/knowledge/evaluation-cli.mjs \
  --repository-directory /path/to/thunderbird-knowledge \
  --source-directory /path/to/comm --mode hybrid \
  --corpus test/fixtures/knowledge-evaluation/public-corpus.json \
  --model-cache /path/to/local-model-cache \
  --output /path/to/local-results/hybrid.json
```

Hybrid mode loads the configured local embedding implementation and indexes the
same section inputs as the service. It then calls production combined exact and
semantic retrieval. It does not claim to measure a separate pure semantic ranker.
The model may download files. A full corpus index can take substantial time. The regular CLI `index` command
now counts pending sections, reports `sectionVectors` separately from
`legacyVectors`, and labels a bounded `--batches N` run as `partial` until no
sections remain. The old `vectors` output field remains a legacy-count alias.
Batch progress uses an estimate; the final remaining count is exact. For a bounded pass:

```sh
node commands/knowledge/cli.mjs index --directory /path/to/cache \
  --repository-directory /path/to/thunderbird-knowledge --batches 20
```

A failed embedding batch cannot report complete coverage. Reports distinguish
complete or partial section vectors, legacy vectors only, and no usable vectors.
Old vectors without a current section or record do not count as coverage. The
stored-vector digest identifies changes independently of immutable source IDs;
it cannot restore the vectors or recover unknown legacy model-weight revisions.
`--model-timeout` sets readiness wait milliseconds, default 30000. Missing models,
failed batches, and failed query vectors are explicitly unavailable. No exact-only
result is substituted for an unavailable hybrid result.

## Retrieval tracing and profiling

The runner saves a trace for every evaluated question. It includes time spent in
exact search, section-vector search, legacy-vector search, claim grouping,
replacement checks, ranking and context assembly. Cached stages can be absent.
Tracing does not change selected evidence or the context text.

Each candidate records its best rank, source family, selected section offsets and
final disposition. Missing-source reports distinguish `source-absent`,
`not-in-candidate-set`, `scope-filter`, `missing-lesson-evidence`, `superseded`,
`context-budget`, `result-limit` and `duplicate-claim`. A selected record still
needs a check that its returned section supports the answer.

For an ordinary CLI search, add `--trace`. Diagnostic data stays outside the
quoted model context. Use this isolated profiler for the exact SQL query:

```sh
node commands/knowledge/evaluation-profile.mjs \
  --index-source /path/to/local-cache/index.sqlite \
  --query 'Where is cal.iterate.forEach implemented?' \
  --timeout-ms 30000 --variant both \
  --output /path/to/local-results/query-profile.json
```

The profiler compares the former SQL query with the production rank-first query.
A child process enforces the query time limit even while SQLite is busy. It opens
the index read-only. Each child has its own snapshot; record counts and query
plans are retained. A timed-out query has a lower time bound, not a measured
completion time. This profile excludes claim grouping, context assembly and model
work. Do not infer an exact speed ratio from different snapshots or cache warmth.

SQLite documents that its hidden `rank` column uses the same default score as
`bm25()` and can sort limited matches more efficiently. The production query
explicitly selects `bm25()` through that column before loading section bodies.
See [SQLite's ranking documentation](https://sqlite.org/fts5.html#sorting_by_auxiliary_function_results).

`--compare-transcripts` scores the old and reduced task-transcript weights in one
run. The reference and current query use the same stored data. Transcripts remain
retrievable; their answers need original-source checks. `--compare-terms` tests an
optional common-word filter against the unchanged all-terms policy. It remains an
experiment because it lost required sources in the checked public set. Compare
one policy at a time. Both switches retain case-level improvements and regressions.
The reference executes first, so timing is not a controlled cache-warmth comparison.

## Console answer provider

`--provider commands/knowledge/console-answer-provider.mjs` uses the configured
console Codex command through the bounded, read-only generator. It returns real
answer text without exposing the expected facts to generation. The provider
inherits the configured default model; the CLI does not report the resolved
model name. Reports state this limit instead of inventing an exact model version.

A three-question smoke run on October 13, 2026 generated real answers for
`named-tasks`, `iterator-snapshot`, and `unknown-regression` against the pinned
319-record public corpus. Every answer cited record IDs present in its supplied
context. This checks citation presence, not whether every cited sentence follows
from its source. Only iterator-snapshot retrieved every fixture source.
The named-task answer omitted the required lint override because that source
was not selected. The unknown-regression answer declined to assign an unsupported
cause. No answer-quality review was performed in that smoke run. Code files changed during this smoke run;
it is provider integration evidence, not a stable before/after quality benchmark.
The complete report stays in a private local result directory.

Scheduled query-gap evaluations use this provider automatically within the daily
learning budget. Their results and source-based review form appear in Background
jobs. See [the feedback flow](knowledge-query-gaps.md).

## Generated answers and automatic source review

Without a provider, answer quality is `not-run`. With a provider, the runner
generates each answer and then reviews it against original sources in a separate
model call. The optional
`commands/knowledge/evaluation-codex-provider.mjs` adapter uses the configured local
Codex model and records its model ID, reasoning setting and CLI version. It calls
the existing bounded, read-only generator with native memories disabled and
an ephemeral session. It gives the model only the question, scope and quoted
context. The prompt forbids tools; the current adapter does not independently
record tool-use events. The CLI still inherits deliberate user instructions and
configured settings, so this is not a blank-context model comparison. See the
[official CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

To generate answers, supply a local
ES module with `--provider /path/to/provider.mjs`. The module must export:

```js
export const configuration = { provider: "provider-name", model: "exact-model", temperature: 0 };
export async function generate(request) {
  // Call the configured provider with request.system, request.question,
  // request.scope and request.context, then return its answer text.
}
```

Use real provider and model settings. Keep credentials out of `configuration`;
that object is saved in the report. This adapter lets the caller use its configured
provider without a hidden fallback. Provider failure stops the run. Generation
receives the question, repository, explicit filters and retrieved context. It does
not receive fixture scope paths, expected source anchors, expected facts or
prohibited claims. Fixture scope paths can contain lookup answers and stay in the
evaluation metadata. Keep private answers and contexts local.

Mechanical answer checks recognize supplied record IDs, section IDs and aliases.
They report missing or unknown citations and separate dependencies whose text was
not quoted. They
cannot decide whether a citation supports a sentence or whether an answer is
correct. Automatic source review checks those claims separately. Its quotes must match
the supplied original sources. The report keeps the reasoning, source text and
reviewer identity so the judgments can be checked and improved.

The assistant checks each required fact, exception and prohibited claim against
original sources. It scores each dimension from 0 to 2:

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Correctness | Material false claim | Partly correct | All stated claims correct |
| Completeness | Main answer missing | Required fact or exception missing | All required facts and exceptions covered |
| Citation support | Missing or false support | Partial support | Each substantive claim has supporting evidence |
| Scope | Wrong repository, API, role or revision | Scope unclear | Correct scope and limits |
| Uncertainty | Invented certainty | Partial qualification | Material gaps stated honestly |

A pass requires 2 in every dimension, every required fact supported, and no
prohibited claim. Each review records `reviewerKind: "assistant"`,
`method: "source-based"`, reviewer and provider settings, reasons, checked source quotes,
source text and digest, and the SHA-256 digest of the exact answer text. Expected
facts guide the review but are checked against original sources; they are not
accepted as proof. The assistant can still misread code or miss an exception.
The retained sources and reasons make that judgment inspectable.

Review saved answers without generating them again:

```sh
node commands/knowledge/evaluation-review.mjs \
  --suite /path/to/the-original-question-set.json \
  --report /path/to/local-results/answers.json \
  --repository-directory /path/to/thunderbird-knowledge \
  --source-directory /path/to/comm \
  --provider commands/knowledge/evaluation-codex-provider.mjs \
  --output /path/to/local-results/reviewed-answers.json
```

The command verifies the question-set digest and original source anchors. It
preserves the original report. Assistant reviews require a verdict and reason for
every required fact and prohibited claim, plus quotes that match saved source
text. Missing or unknown answer citations cannot pass on model scores alone.
Source text is limited to 120,000 characters per question; truncation is recorded
and must limit the review's claims. Review fields include the exact source revision.

Existing saved reviews can be attached with `--reviews /path/to/reviews.json`
instead of `--provider`. Both assistant and human review kinds are supported and
reported separately. Human review is optional. Background query-gap evaluations
review answers automatically within the shared daily budget and preserve saved
answers when review must wait for the next budget window.

## Grow the set without contaminating the corpus

Read original code and relevant callers. Check the retained review or commit
outcome and preserve uncertainty. Pin source revision, path and blob ID. Add exact
record IDs and verified alternate evidence only. Record why evidence is unavailable
when a correct answer must say it is insufficient. Add realistic wording without
copying the expected answer into the question.

Keep questions and expected answers in this tb-tools fixture directory. Never add
them to knowledge `notes/`, `records/`, learning jobs, or ingestion inputs. The
runner imports only the ordinary knowledge checkout and performs no learning or
publication. The record validator also rejects fixture paths and `knowledge-evaluation` source records before indexing or learning. Its cache is disposable. Public fixtures contain no private transcript,
restricted review content, credentials or personal source paths. Retain private
cases in a separate local fixture and use `--suite` to select them.

Run focused checks after fixture or evaluator changes:

```sh
node --test test/knowledge-evaluation.test.mjs test/knowledge-retrieval-trace.test.mjs test/knowledge-source-review.test.mjs test/knowledge-semantic-index.test.mjs
npx eslint commands/knowledge/evaluation*.mjs commands/knowledge/retrieval-*.mjs \
  test/knowledge-evaluation.test.mjs test/knowledge-retrieval-trace.test.mjs
```
