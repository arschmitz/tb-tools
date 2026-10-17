# Compact behavior ingestion

This adapter reduces repeated writing in reviewed source ingestion. It stores one
specific explanation per frozen unit, applicable facts, and references to shared
contracts. A unit is a function, nested callback, or independently checked source
section. This is an experimental representation, not a claim of complete behavior
understanding or a measured speed improvement.

The adapter uses the immutable mailbox in `ingestion-grouped.mjs`. It does not
modify that adapter, publish Git changes, run product tests, or change instructions.
Local queues, packets, and indexes must remain outside the source and shared
knowledge repositories. Thunderbird Suite remains excluded.

## Prepare and run

Use the grouped adapter's version-1 configuration. Add `compactVersion: 1` and
optionally `deadlineAt` with an exact timestamp and timezone. Freeze groups,
repositories, revisions, target paths, expected units, and relationship obligations
before initialization. Both source and configuration hashes are checked.

```sh
node commands/knowledge/ingestion-compact.mjs --init config.json
node commands/knowledge/ingestion-compact.mjs --directory /private/queue
node commands/knowledge/ingestion-compact.mjs --directory /private/queue --submit response.json
node commands/knowledge/ingestion-compact.mjs --directory /private/queue --export
```

Initialization writes the source bundles and `compact-facts/<group>.json`. The
facts contain exact source and unit hashes, sizes, ranges, and supported generated
local body facts. JavaScript uses the existing `body-facts.mjs` implementation.
Its lexical call resolution does not establish dynamic receivers, external callers,
or runtime execution. Unsupported languages receive no automatic family facts.
They can still receive individual source analysis. Non-UTF8, binary, missing, or
oversized sources that fail preparation remain selected failures and cannot count
as complete. Parser failures and inventory gaps must remain explicit.

Each status lists the current producer, reviewer, or repair request. Workers submit
actual identity and timestamps. The original and repaired attempts remain immutable.
A producer cannot independently review its own result. A finished review does not
mean that knowledge was published or that a product test passed.

## Compact producer response

Keep the grouped response identity, timing, files, contracts, relationship checks,
test links, and gap fields. Each unit replaces the eight repeated prose fields with:

```json
{
  "id": "frozen-unit-id",
  "explanation": "Explains this unit's behavior, conditions, result and distinct effects.",
  "anchors": [{ "sourceId": "repository:path", "start": 10, "end": 15 }],
  "facts": [{
    "status": "observed",
    "claim": "A specific additional effect supported by the source.",
    "anchors": [{ "sourceId": "repository:path", "start": 12, "end": 13 }]
  }],
  "contractRefs": ["shared-contract-id"]
}
```

`facts` and `contractRefs` can be empty. Do not use missing fields to claim absence
of an effect. The explanation and applicable facts must still account for branches,
state, results, failures, async completion, cancellation and ownership where relevant.
An anchor must cover the unit's own frozen source range. Relationships and facts
use `observed`, `inferred`, or `unresolved`. A file containing inferred or unresolved
relationships cannot claim complete coverage. Every relationship obligation needs
an explanation, status, and source anchors, including a checked not-applicable claim.

Test links use `direct`, `execution-only`, or `possible`. `execution` must be
`not-run`; execution results require separate revision and environment receipts.
Source tests being present does not establish that they pass.

## Strict reuse

Shared contracts have `id`, `kind`, `explanation`, and `anchors`. Kind `shared`
provides supporting context but cannot establish body-family membership.

Kind `body-rule` names one existing whole-local-body rule: `return-primitive`,
`return-bound-parameter`, or `empty-or-bare-return`. The adapter regenerates these
facts from pinned source. A member must provide `reuse.contractId`, `reuse.factId`,
and `reuse.bodyHash`. Its frozen expected unit must contain the exact independent
`functionRangeUtf16` pair. This identifies the whole function by character offsets,
not a name or enclosing line range. A nested same-line function cannot supply the
outer function's rule. Unsupported syntax and absent ranges cannot use this mode.

Kind `exact-body` identifies `targetId`, `unitId`, and `bodyHash`, where the hash
matches the exact frozen line slice. Each member must match those bytes. This mode
makes no claim that different bodies are equivalent.

Both modes require seven member-specific `reuse.bindings`: `receiver`, `arguments`,
`branches`, `state`, `errors`, `completion`, and `ownership`. Each is an object with
a concrete `claim` and checked `anchors`. State absence only when the source proves
it. Include caller entry and result-consumption constraints. Identical syntax or a
matching generated rule is necessary but insufficient to establish full behavior.
The adapter checks binding presence and exact evidence; the independent reviewer
checks whether the bindings are true. That review can still make mistakes.

The generated local rule and each member's actual value or parameter remain in the
export. Shared family prose must not flatten distinct return values or callers.

## Reuse an accepted contract across files

A later producer in the same queue can reference a shared definition without
copying or re-reviewing that definition. Put only these fields in its contract:

```json
{
  "id": "primitive-return",
  "reference": {
    "producerHash": "exact original producer object hash",
    "reviewHash": "exact original review object hash",
    "contractId": "primitive-return"
  }
}
```

The adapter verifies both immutable objects, the independent definition check,
actual receipt times, and a complete original file that used the contract. Partial,
rejected, unchecked and late origins cannot supply accepted definitions. A reference
cannot replace fields in the definition. Point directly to the original definition;
references to inherited copies are rejected.

The current unit must still prove its generated rule or exact body membership and
provide all contextual bindings. The current reviewer must check every new member.
The inherited definition can be omitted from `checkedContractIds`; newly written
contracts still need an independent definition check. Supporting shared contracts
also retain their original acceptance requirements.

The exported current file records `source.reusedContracts` with original hashes,
contract ID and note filename. It links the original contract note. Source anchors
are converted to exact repository, revision, path and ranges before validation.
No external lookup or same-name match can establish this reference.

## Independent review and deadline

Use the grouped review fields. Add `checkedContractIds` globally and
`checkedReuseUnitIds` for each file. Empty arrays are valid when nothing is reused.
A complete file needs every frozen unit, every reuse member, and every used contract
independently checked. The reviewer must check the inventory for omitted bodies and
sections. An unchecked inventory or known extraction gap cannot become complete.

`deadlineAt` rejects new submissions after the cutoff. The adapter also stores its
own completed submission receipt after source validation and mailbox work. If that
receipt crosses the cutoff, the group receives no export or throughput credit.
Claims about when a producer finished do not override actual receipt time. A late
response may remain as private audit evidence. Publication and retrieval clocks
must be measured by the outer benchmark; this adapter cannot establish those results.

## Export and consumption

`--export` returns `state: "drafts-not-published"`. Under `compact-exports/`:

- `records` lists behavior notes with target ID, decision, UUID filename and hash.
- `contracts` lists UUID notes for used shared behavior contracts.
- `evidence` lists UUID notes containing deduplicated exact source excerpts.
- `preparationFailures`, `pendingGroups`, and `blockedGroups` preserve work limits.

Publish all referenced note lists together. Only complete behavior records count
as accepted file origins. Evidence and contract notes do not increase that count.
Notes link to original pinned source and relative shared evidence filenames, so
standalone readers can search ordinary Markdown. Shared evidence is reused within
the queue; later queues receive new immutable note identities. Source revisions,
file context, prior evidence, correction references, and copy IDs remain attached.
Private queue paths and source-cache filenames are not copied into note metadata.
Only public prior-evidence fields should be supplied for publication.

The older mailbox requires eight legacy fields. The adapter fills them with an
explicit transport-only tag containing no claim. Compact exports never render
these tags. Do not use the grouped exporter for compact queues.

The export is not a full console retrieval check. The caller must import, retrieve,
and publish the complete contribution, record actual timings, and retain failures.
