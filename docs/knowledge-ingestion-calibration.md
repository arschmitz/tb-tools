# Prepare source for ingestion calibration

The standalone preparer creates source packets from pinned Git commits. A packet
contains the complete selected source, nearby build or sibling files, literal
search results, and explicit open analysis obligations. It does not explain the
implementation or certify callers, tests, or behavior.

Run it with Node.js 22.13 or later from a tb-tools checkout. It uses built-in Node
modules and the existing Git reader. Source checkouts must already contain the
specified commits. No network or model service is used.

```sh
node commands/knowledge/ingestion-workload.mjs --config /path/to/private/packet-config.json
```

Example configuration:

```json
{
  "version": 1,
  "repositories": [
    {
      "id": "thunderbird",
      "directory": "/path/to/comm",
      "revision": "FULL_40_CHARACTER_COMMIT_ID"
    }
  ],
  "targets": [
    {
      "id": "template-utils",
      "repository": "thunderbird",
      "path": "mailnews/base/src/TemplateUtils.sys.mjs",
      "language": "JavaScript",
      "role": "production",
      "searchScopes": ["mailnews/base/src"]
    }
  ],
  "knowledgeDirectory": "/path/to/thunderbird-knowledge",
  "output": "/path/to/private/new-packets",
  "cache": "/path/to/private/source-cache",
  "maxLeads": 80
}
```

Replace the revision placeholder with a real full commit ID. Repository IDs in
`targets` and `repositories` must match exactly. Existing Firefox knowledge uses
`git:314d8065c5ad68c7e5c5f92d`; `firefox` is not an automatic alias. An optional
`oid` checks the target against a known Git blob. Optional `start` and `end`
select an inclusive line range; the packet also retains the whole file.

Use a fresh output directory for each run. The tool refuses to overwrite packet
files or reports. Reuse the cache directory for a warm run. Every cached source
must still match its Git blob hash. Output and cache paths must be outside the
configured source and knowledge checkouts, including through symbolic links.

`report.json` records times, cache reads, prepared targets, omitted search leads
and failures. Each packet retains source revisions, hashes and original source.
Binary, non-UTF-8, symbolic-link and over 4 MB targets remain explicit failures.
They stay in the workload; preparation failure does not exclude them from the
requested analysis. Git/process failures stop the command and must be resolved
before considering that run complete.

## Reuse and relationship checks

Optional `priorEvidence` entries contain `id`, `repository`, `revision`, `path`,
`start`, `end`, `sourceHash`, and the original coverage description. `sourceHash`
is SHA-256 of the selected lines joined with newline characters, without adding
a final newline. The tool checks source identity but does not validate the prior
interpretation. A matched body description does not complete its callers or tests.
If no prior evidence set is supplied, the packet says `not-looked-up`. An analyst
must still search relevant shared records before creating another description.

Nearby searches use literal names in the specified paths. They do not resolve an
import, prove a receiver, or establish a test assertion. Counts record omitted
leads when `maxLeads` is reached. The analyst must search beyond these limits when
the implementation needs it. A dynamic target remains unresolved until evidence
supports it. No code from a source packet is executed by this tool.

## Sample an existing workload ledger

A newline-delimited JSON ledger can supply one row per repository/path/revision.
Rows should preserve `bytes`, `language`, `primaryRole`, `scope`, `sizeBand` and
`disposition`. Missing classifications remain unknown. Thunderbird `suite/` rows
remain counted as exclusions. Non-text and failed-parser rows remain eligible.

```sh
node commands/knowledge/ingestion-workload.mjs \
  --ledger /path/to/private/file-dispositions.jsonl \
  --output /path/to/private/new-sample.json \
  --seed repeatable-seed --per-stratum 1
```

A stratum is a group with the same repository, language, role and size band.
Selection sorts a stable hash of the seed and source identity in each group.
Changing JSONL row order does not change the selection. The sample report retains
each group population and selected rows. Store this report outside shared Git.
A packet configuration can supply `ledger`, `seed` and `perStratum` instead of
`targets`; preparation is limited to 1,000 selected targets per call.

Size is not behavioral complexity. One selected file per group cannot establish
variation or a reliable full-repository completion estimate. Measure analysis,
independent review, corrections, publication and retrieval separately from source
preparation. Keep unfinished samples and record actual elapsed time. Do not turn
an incomplete sample into a completed file or use a body rate as a chain rate.

This module provides sampling and source preparation. It is not a worker service,
semantic resolver or complete ingestion scheduler. It has no `tb knowledge`
command-router integration. Ordinary files and the direct Node command work
without the console application.

## Checks

```sh
node --import=./test/block-external-apis.mjs --test test/knowledge-ingestion-workload.test.mjs
npx --no-install eslint commands/knowledge/ingestion-workload.mjs test/knowledge-ingestion-workload.test.mjs
```

The tests cover revision pinning, duplicate contexts, failed source identities,
unsupported inputs, cache integrity, bounded unverified matches, scoped prior
claims, output paths and deterministic selection. They do not establish correct
behavioral analysis of arbitrary source.
