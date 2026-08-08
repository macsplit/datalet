# Documentation Index

Which documents describe the project as it is now, and which are records of
work already finished. Historical documents are kept for their reasoning and
measurements; where one of them states something that later changed, it says so
at the point of the claim.

## Current

| Document | What it is |
|---|---|
| [`product-gaps-plan.md`](product-gaps-plan.md) | **The active plan.** Ordered remaining work, what is explicitly out of scope, and the next step. |
| [`product-evaluation-2026-08-08.md`](product-evaluation-2026-08-08.md) | What the project is good and bad at. Kept accurate as work lands. |
| [`remote-sync.md`](remote-sync.md) | Current-state reference for the sync tier: endpoints, conflict rules, edge cases. |
| [`remote-sync-deployment.md`](remote-sync-deployment.md) | Deployment guide. Compose and systemd paths; the snippets are templates, not checked-in files. |
| [`remote-sync-architecture.md`](remote-sync-architecture.md) | Design reasoning behind the sync tier, marked implemented. Read for *why*, not *what*. |

## Historical

| Document | What it recorded | Closed |
|---|---|---|
| [`project-next-steps.md`](project-next-steps.md) | Acceptance checklist for the 2026-08-08 review tranche. All items done; superseded by the plan above. | 2026-08-08 |
| [`remote-sync-progress.md`](remote-sync-progress.md) | Step-by-step build log for the sync tier, including every bug found and how it was verified fixed. | after step 11 |
| [`incremental-persistence-progress.md`](incremental-persistence-progress.md) | Build log and write-cost measurements for per-record `localStorage` persistence. | complete |
| [`remote-sync-endurance-results.json`](remote-sync-endurance-results.json) | Partial endurance run, `status: curtailed` at ~19 of a planned 120 minutes. A real multi-hour run is step 10 of the plan. | curtailed |

## Diagrams

`diagrams/` holds D2 sources and their rendered PNGs. Regeneration is described
in `remote-sync-architecture.md` §12.
