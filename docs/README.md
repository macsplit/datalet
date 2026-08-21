# Documentation Index

## Start here

| Document | What it is |
| --- | --- |
| [`architecture.md`](architecture.md) | **How the whole thing works today** — the browser engine, the metadata model, the optional sync tier, and where the constraints are. Read this first. |
| [`roadmap.md`](roadmap.md) | What is left, what was deliberately deferred, and what is out of scope on purpose. |
| [`product-assessment.md`](product-assessment.md) | What the project *is*, what it is good for, and which additions would cost it that. Kept accurate as work lands. |
| [`multiple-datalets-plan.md`](multiple-datalets-plan.md) | **Proposed, not started.** Holding several datalets and using one at a time, why only the active one can be resident, and why that makes more than one require sync. Includes the storage arithmetic it turns on. |
| [`datalet-add-and-clone-plan.md`](datalet-add-and-clone-plan.md) | **Proposed, not started.** How a datalet is gained — started, joined, cloned or restored — why joining and cloning are opposites, and why a clone code hands over everything. |

## Sync tier

| Document | What it is |
| --- | --- |
| [`remote-sync.md`](remote-sync.md) | Operational reference: endpoints, conflict rules, edge cases, non-functional characteristics. |
| [`remote-sync-deployment.md`](remote-sync-deployment.md) | Deployment guide. Compose and systemd paths; the snippets are templates, not checked-in files. |
| [`remote-sync-architecture.md`](remote-sync-architecture.md) | Design rationale — what was considered and rejected, and why. Read for *why*, not *what*. Its section numbers are cited from `server/src/` doc comments, so they stay stable. |

## Historical

| Document | What it recorded |
| --- | --- |
| [`theme-in-graph-plan.md`](theme-in-graph-plan.md) | **Complete.** How the colour theme became graph data, why it generates a stylesheet rather than inline custom properties, and why font choice was declined outright. Also the origin of the app's Content Security Policy. |
| [`multi-tenancy-and-identity-plan.md`](multi-tenancy-and-identity-plan.md) | **Complete.** How multi-tenant hosting and user-facing identity were planned and built, item by item, including the deviations from the plan and why. Read for the reasoning behind the sharded materializer, the quotas, and the `LG1` pairing credential. |
| [`build-history.md`](build-history.md) | How the sync tier and the persistence layer were built, and — the part still worth reading — every real defect found, how it was found, and what changed. Condensed from three longer work journals. |
| [`remote-sync-endurance-results.json`](remote-sync-endurance-results.json) | Partial endurance run, `status: curtailed` at ~19 of a planned 120 minutes. A real multi-hour run is the one open item in `roadmap.md`. |

## Diagrams

`diagrams/` holds D2 sources and their committed PNGs. The PNGs are committed
rather than rendered on view, so the docs keep working without a third-party
service. Regeneration is described in `remote-sync-architecture.md` §11.
