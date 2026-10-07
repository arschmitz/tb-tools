# Try status audit

Raw API audit of all 12 managed attempts. No AI calls were made. Prior records and raw API results were saved in /Users/aschmitz/.tb-tools/try-monitor/audits/2026-09-29T15-12-50.898Z.

All 12 attempts are complete and have failed jobs. Two have no successful builds. Saved AI assessments are retained separately; they are not proof of a clean CI run.

| Run | CI | Failed jobs | Successful builds |
| --- | --- | ---: | ---: |
| [Bug 2061199](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98323) | Complete | 10 | 0/18 |
| [Bug 2061191](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98281) | Complete | 18 | 14/19 |
| [Bug 2061213](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98280) | Complete | 20 | 14/20 |
| [Bug 2065519](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98248) | Complete | 12 | 14/18 |
| [Bug 2061213](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98279) | Complete | 20 | 14/18 |
| [Bug 2061188](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98277) | Complete | 33 | 14/21 |
| [Bug 2061188](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98324) | Complete | 10 | 0/18 |
| [Bug 2061188](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98316) | Complete | 14 | 14/18 |
| [Bug 2065519](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98228) | Complete | 18 | 14/18 |
| [Bug 2061213](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98226) | Complete | 71 | 18/19 |
| [Bug 2014106](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98282) | Complete | 18 | 18/23 |
| [Bug 2061192](https://treeherder.mozilla.org/jobs?repo=try-comm-central&landoInstance=lando-prod-2025&landoCommitID=98276) | Complete | 37 | 14/18 |

Confirmed defects: superseding work discarded unresolved display status; investigation state overwrote raw CI status; an optional missing log aborted evidence collection despite other available logs; failed-build AI verdicts could override build readiness. One saved workflow reached 30 assessment attempts. That counter includes evidence-fetch failures and does not prove 30 model calls.

Automatic Try AI is suspended. The store contains 225 imported historical records; these were not sent to AI or refetched in this audit. Their unknown cause classifications remain historical records. New UI status Fail with an unclassified cause records failed CI, not an invented AI verdict. Existing unrelated verdicts were preserved where their failure IDs still cover the run; this audit did not independently revalidate their reasoning.

The monitor also ignored the server's checkout list. This allowed a server with no graphs to scan real saved workflows. The monitor now filters by the supplied checkout paths. Regression tests cover both an empty list and an unrelated checkout. This defect is confirmed; its contribution to account usage has not been measured.

Verification used the real saved records through the graph attachment code: 9 commit cards produced 15 managed Try badges, with no completed managed attempt shown as Pending or Unknown. Historical imported records remain separate. The existing console process must reload the changed server modules before it uses this behavior. Automated Try AI remains disabled by the persistent `.automation-paused` file; no model calls were made during this audit. This is not an end-to-end claim that automatic repair is reliable.

## September 29: repair recovery and conflicting displays

Two live console servers used the same saved workflows. The loader run had an
all-unrelated assessment while the workflow still said repairing. An interrupted
positioning analysis stayed behind its old retry timer. Its fixup targeted the
routing patch, which was not named in the background card.

Changes:
- One monitor owns automatic work across console processes. A second monitor can
  take over after the owner stops or exits.
- Restart closes a completed all-unrelated assessment without another AI call.
- Interrupted analysis resumes immediately. The same failed jobs reuse gathered
  evidence on retry.
- Cards show the repair target, actual worker state, and the next action. Idle
  badges show queued or waiting to retry. Finished jobs have no retry timer.
- Evidence retrieval uses six concurrent workers and shows completed push count.
  It still checks the latest 50 pushes per repository and retains every failure.
  Shutdown aborts network retrieval as well as AI work.

Live checks used one current console at port 4310 and the actual saved records.
The loader showed finished/passed. The positioning workflow resumed gathering
CI evidence and named Bug 2061188 as its repair target. This is recovery proof;
it does not claim the positioning Try passed before its assessment completes.

## September 29: confirmed server memory crash

The Node server exited at its roughly 4 GB heap limit. A raw CI log was
498 MB. Loading and splitting whole logs during concurrent comparisons caused
large allocations. The page retained its last status after the server exited.

The evidence reader and signature extractor now read logs one line at a time.
Downloads stream to disk. Both readers processed the actual 498 MB log under a
128 MB JavaScript heap limit. Completed comparison pushes are cached on disk.
Remote evidence failures are recorded explicitly; they do not discard all other
comparison results. Missing evidence remains missing, never a success result.
The browser warns when its server connection fails and preserves open forms.
