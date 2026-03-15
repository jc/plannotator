# Add file-local revision strip for checkpointed diff-floor review

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

`PLANS.md` is checked in at `PLANS.md` in the repository root. This document must be maintained in accordance with that file.

## Purpose / Big Picture

Plannotator already supports per-file review checkpoints, but reviewers cannot yet see or pick the file-local revision floor explicitly. After this change, each reviewed file can show a compact revision strip where every cell represents a file-touching review snapshot, with independent markers for head, selected floor, and reviewed checkpoint. The reviewer can inspect a broader or narrower diff floor without mutating their persisted checkpoint, then mark the file reviewed through the currently selected revision.

The user-visible behavior is: open a file, see the revision strip, click any strip cell to set the diff floor (`selected -> head`), and use “Mark reviewed through here” or “Clear reviewed state” explicitly.

## Progress

- [x] (2026-03-15 01:04Z) Created ExecPlan and re-validated current review/checkpoint architecture in `packages/server/review-state.ts`, `packages/server/review.ts`, `packages/review-editor/App.tsx`, and `apps/pi-extension/server.ts`.
- [x] (2026-03-15 02:08Z) Implemented Bun-side revision strip derivation and floor snapshot resolution in `packages/server/review-state.ts`, and wired new API behavior in `packages/server/review.ts` (`/api/review/file-history`, `throughSnapshotId`, `floorSnapshotId`).
- [x] (2026-03-15 02:20Z) Implemented Node Pi extension parity in `apps/pi-extension/server.ts`, including snapshot persistence, file-history endpoint, floor-based view retrieval, and mark-reviewed-through-selected behavior.
- [x] (2026-03-15 02:26Z) Wired active-file revision strip UI and selected-floor behavior in `packages/review-editor/App.tsx`, `components/DiffViewer.tsx`, `components/FileHeader.tsx`, and styling in `packages/review-editor/index.css`.
- [x] (2026-03-15 02:31Z) Added focused strip tests in `packages/server/review-state.test.ts` and ran validation builds/tests (`storage.test`, `review-state.test`, `build:review`, `build:hook`, `build:opencode`, `build:pi`).
- [x] (2026-03-15 02:55Z) Extended strip model to support adjustable ceiling revision (`floor -> ceiling` range), updated Bun+Pi APIs (`ceilingSnapshotId`), and wired dual From/To strip controls so users can review `base -> c2` and `c1 -> c2` directly.
- [x] (2026-03-15 03:07Z) Fixed ceiling-selection crash by normalizing new-file diff headers to parser-compatible `diff --git a/<file> b/<file>` in Bun and Pi delta/no-change patch builders.
- [ ] (2026-03-15 03:08Z) Full click-through manual UI acceptance in browser remains to be run end-to-end (API-level range/ceiling acceptance checks completed in sample repo).

## Surprises & Discoveries

- Observation: Existing checkpoint state already stores `snapshotId`, `patchHash`, and `baselineNewContent`, which is enough to persist “reviewed through selected revision” semantics without creating a new persistence file.
  Evidence: `packages/server/review-state.ts` `ReviewCheckpoint` schema.

- Observation: Snapshot records are keyed by content hash, so a previously seen snapshot can reappear without a fresh timestamp. Relying only on `createdAt` ordering can put current head in the middle of the strip when users revisit older revisions.
  Evidence: Sample repo smoke produced cells ordered as newer-content then older-content until logic explicitly moved `current snapshotId` to strip tail/head.

- Observation: In Pi runtime, route parity alone was insufficient; the strip needed persisted snapshot records (`pi-snapshots.json`) in addition to checkpoints.
  Evidence: `apps/pi-extension/server.ts` initially had no snapshot persistence, so strip history could not be derived before this milestone.

- Observation: Floor-only selection could not satisfy user workflows like `base -> c2` and `c1 -> c2`; an independent ceiling selector is required.
  Evidence: User validation explicitly requested adjustable right bound, and API smoke verified expected ranges only after adding `ceilingSnapshotId`.

- Observation: `@pierre/diffs` rejects patches whose `diff --git` left path is `/dev/null`; it expects `a/<path> b/<path>` even when `--- /dev/null` is present for added files.
  Evidence: Reproduced parser error (`Cannot read properties of undefined (reading 'trim')`) on `base -> c2` for newly added file until delta builders normalized the `diff --git` header.

## Decision Log

- Decision: Use file-local review snapshots (already persisted) as strip cells instead of introducing commit-only cells.
  Rationale: The current system already persists snapshot metadata and is consistent across review sessions/runtimes; this keeps the feature bounded and avoids introducing git-graph coupling.
  Date/Author: 2026-03-15 / Pi

- Decision: Keep `selected floor` as UI-local state and keep `reviewed checkpoint` persisted; only checkpoint actions mutate persistence.
  Rationale: This preserves the required semantic separation between temporary inspection (`selected`) and persisted review progress (`reviewed`).
  Date/Author: 2026-03-15 / Pi

- Decision: Keep full-diff floor as an explicit non-snapshot mode (`selectedFloorSnapshotId = null`) surfaced as an “All” control in the strip.
  Rationale: The required default “full current diff” behavior has no natural touched-snapshot cell when a file has only one snapshot cell.
  Date/Author: 2026-03-15 / Pi

- Decision: When rendering strip order, force the current snapshot to the rightmost/head position even if persisted `createdAt` ordering would place it earlier.
  Rationale: Head semantics must reflect the currently loaded review context, not historical insertion order artifacts.
  Date/Author: 2026-03-15 / Pi

- Decision: Extend file-view contract with optional `ceilingSnapshotId` and model displayed patch as `floor -> ceiling` (with ceiling defaulting to head), rather than only `floor -> head`.
  Rationale: This is the minimal API extension that enables targeted commit-window review without introducing a global revision matrix.
  Date/Author: 2026-03-15 / Pi

- Decision: Emit parser-compatible single-file patch headers as `diff --git a/<path> b/<path>` even for add/delete/no-change synthetic ranges.
  Rationale: UI renderer stability depends on `@pierre/diffs` accepting all range outputs, including base-to-added-file ranges.
  Date/Author: 2026-03-15 / Pi

## Outcomes & Retrospective

Core implementation is complete across both Bun and Pi Node runtimes: active-file strip cells now represent file-touching snapshots, selected floor is independent from reviewed checkpoint, and mark-reviewed can persist through selected revision. The range model now supports adjustable ceiling as well (`floor -> ceiling`), enabling targeted windows such as `base -> c2` and `c1 -> c2`. The review UI surfaces this via dual From/To strip controls and updated action labeling.

The remaining gap is a full manual browser click-through in the sample repo to capture user-facing transcript evidence (the implementation was verified via API-level scripted acceptance and build/test validation).

## Context and Orientation

`packages/server/review-state.ts` currently persists snapshots and checkpoints under `~/.plannotator/review-state/<project>/` and derives file status (`unreviewed`, `reviewed`, `needs-rereview`, `skipped`). `packages/server/review.ts` exposes review APIs for Bun-backed hook/review runtimes.

`apps/pi-extension/server.ts` is a Node-specific duplicate server used by Pi extension sessions. It has route parity for current checkpoint APIs but does not yet expose a file revision-strip model.

`packages/review-editor/App.tsx` currently switches between full and delta modes via `/api/review/file-view`. `packages/review-editor/components/FileHeader.tsx` is the best location for an active-file revision strip because it already contains file-local controls.

A “revision strip cell” means one file-touching snapshot in chronological order for the active diff scope. “Head cell” means latest touched snapshot for the file in scope. “Selected floor” means the currently chosen left-side bound used to compute `selected -> head` patch for display.

## Plan of Work

First, extend server derivation in `packages/server/review-state.ts` with a file revision-strip response that includes cells, head snapshot, reviewed checkpoint snapshot, and default floor snapshot. Add helper lookup by snapshot ID for “mark reviewed through selected revision” and floor-based patch generation.

Then extend `packages/server/review.ts` with a `GET /api/review/file-history` endpoint and enhance `POST /api/review/file-view` to accept `floorSnapshotId` in addition to the current `viewMode` behavior. Extend `POST /api/review/checkpoint` to accept optional `throughSnapshotId` for `mark-reviewed`.

After Bun server behavior is stable, mirror the same behavior in `apps/pi-extension/server.ts` so Pi sessions are fully consistent.

Finally, wire UI state in `packages/review-editor/App.tsx` to load active-file strip data, keep selected floor in local state, request floor-based patches, and send checkpoint updates through selected floor. Update `FileHeader.tsx` to render strip cells and revised action labels. Add styles in `packages/review-editor/index.css`.

## Concrete Steps

Run from repository root.

1. Implement Bun server strip/floor support and tests.

    bun test packages/server/review-state.test.ts

2. Implement Pi extension Node server strip/floor parity and run a direct API smoke.

    bun -e "import { startReviewServer } from './apps/pi-extension/server.ts'; /* smoke */"

3. Wire review-editor strip UI and rebuild artifacts.

    bun run build:review
    bun run build:hook
    bun run build:opencode
    bun run build:pi

4. Manual acceptance in sample repo.

    cd /Users/james/tmp/plannotator-review-sample-20260314-202931
    # Launch review through Pi path and verify selected-floor strip behavior on src/review.ts

## Validation and Acceptance

Acceptance criteria for one file (`src/review.ts`) in the sample repo:

1. Strip renders file-local snapshot cells with head marker, selected marker, and reviewed marker.
2. Default selected floor is the reviewed checkpoint when one exists and is older than head.
3. Clicking another strip cell changes displayed diff to `selected -> head` without changing reviewed marker.
4. “Mark reviewed through here” updates reviewed marker to selected cell.
5. “Clear reviewed state” removes reviewed marker and defaults back to full-diff behavior.
6. Pi extension runtime and Bun runtime both honor the same strip/floor semantics.

## Idempotence and Recovery

All server persistence updates are additive JSON writes under `~/.plannotator/review-state/*` and can be reset by removing project subdirectories. Re-running UI/build steps is safe. If malformed JSON is encountered, recovery behavior must preserve `.corrupt-*` copy and continue with empty state.

## Artifacts and Notes

Validation snippets collected during implementation:

    $ bun test packages/server/review-state.test.ts
    8 pass
    0 fail

    $ bun run build:review
    vite v6.4.1 building for production...
    ✓ built in 2.44s

    $ bun run build:pi
    ...
    ✓ build complete (review/hook html copied to pi-extension)

Sample repo API smoke for two strip cells and floor diff:

    cells 2 rev_b444f5f0cf9e,rev_3f7207266ca9 head rev_3f7207266ca9
    viewMode delta hasHunk true

## Interfaces and Dependencies

In `packages/shared/types.ts`, add shared strip types:

- `FileRevisionCell`
- `FileRevisionStripResponse`

In `packages/server/review-state.ts`, add strip derivation helpers and floor lookup helpers used by both route handlers and tests.

In `packages/server/review.ts` and `apps/pi-extension/server.ts`, route contracts must support:

- `GET /api/review/file-history?reviewerId&filePath&oldPath?`
- `POST /api/review/file-view` with optional `floorSnapshotId`
- `POST /api/review/checkpoint` with optional `throughSnapshotId`

Plan Revision Note (2026-03-15, Pi): Created initial execution plan for file-local revision strip feature based on current checkpoint implementation and the supplied handoff semantics.

Plan Revision Note (2026-03-15, Pi): Updated progress, discoveries, decisions, outcomes, and artifacts after implementing Bun + Pi runtime strip/floor behavior, adding tests, and running build/test/API validation.
