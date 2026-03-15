# Implement Reviewable-lite File Checkpoints for Agent Diff Reviews

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

`PLANS.md` is checked in at `PLANS.md` in the repository root. This document must be maintained in accordance with that file.

## Purpose / Big Picture

Today Plannotator can show a code diff, let a reviewer annotate lines, and send feedback, but it cannot remember that a reviewer already approved a specific file revision. After this change, a reviewer will be able to mark a file as reviewed at the current revision, return after an agent update, and automatically see only the new changes since their last review for that file. The reviewer can still switch to the full current diff at any time, skip a file for now, and later review that file fully.

The user-visible outcome is a stable “review diff by diff” loop for iterative agent edits without rebuilding full Reviewable semantics.

## Progress

- [x] (2026-03-14 22:12Z) Inspected current review stack (`packages/review-editor`, `packages/server/review.ts`, `packages/server/git.ts`) and confirmed there is no persistent file-level review checkpoint model.
- [x] (2026-03-14 23:08Z) Implemented server-side snapshot/checkpoint persistence in `packages/server/review-state.ts` and wired `GET /api/review/state`, `POST /api/review/checkpoint`, and `POST /api/review/file-view` in `packages/server/review.ts`.
- [x] (2026-03-14 23:14Z) Replaced transient “Viewed” UX with review-status-aware UI actions and status chips across `packages/review-editor/App.tsx`, `components/FileHeader.tsx`, `components/FileTree.tsx`, `components/FileTreeNode.tsx`, and `index.css`.
- [x] (2026-03-14 23:18Z) Added focused coverage in `packages/server/review-state.test.ts` for status derivation, skipped persistence, corrupt JSON recovery, and delta patch generation.
- [ ] (2026-03-14 23:20Z) Validation commands completed (`bun test packages/server/storage.test.ts`, `bun test packages/server/review-state.test.ts`, `bun run build:review`, `bun run build:hook`, `bun run build:opencode`, plus API smoke), but the full manual two-session UI acceptance loop is still pending.
- [x] (2026-03-14 23:36Z) Fixed runtime parity gap in `apps/pi-extension/server.ts` by adding Node-side review endpoints (`/api/review/state`, `/api/review/checkpoint`, `/api/review/file-view`) and supporting routes (`/api/file-content`, `/api/git-add`) so new file-level review controls work in Pi extension sessions.
- [x] (2026-03-14 23:44Z) Fixed Pi-only delta rendering bug in `buildDeltaPatch` (unsupported `git diff --no-index --label` usage) so `Review new changes` now returns true baseline-vs-current hunks instead of silently falling back to full patch.

## Surprises & Discoveries

- Observation: The existing “Viewed” file state is purely in-memory UI state and resets every review session.
  Evidence: `packages/review-editor/App.tsx` keeps `viewedFiles` in `useState(new Set())` and never writes it to server or disk.

- Observation: The review server already exposes file content for old/new sides of a diff, which can power delta generation without line-remapping infrastructure.
  Evidence: `packages/server/review.ts` provides `GET /api/file-content`, backed by `getFileContentsForDiff()` in `packages/server/git.ts`.

- Observation: There is already a proven pattern for persistent local state under `~/.plannotator` and for deduplicated history by project.
  Evidence: `packages/server/storage.ts`, `packages/server/draft.ts`, and `packages/server/sessions.ts` all persist structured JSON/markdown under `~/.plannotator/*`.

- Observation: `diff` package output is not structurally uniform across scenarios; for new-file patches it omits the `Index:` line and starts directly with the separator line.
  Evidence: Initial `buildDeltaPatch` test failed until normalization logic in `packages/server/review-state.ts` handled both output shapes (`Index:` present vs separator-only).

- Observation: Pi extension uses a Node-only review server (`apps/pi-extension/server.ts`) with duplicated API routes, so features added to `packages/server/review.ts` do not automatically exist there.
  Evidence: UI controls rendered from shared `review-editor.html`, but checkpoint actions no-op’d in Pi sessions until the Node server implemented `/api/review/*` routes.

- Observation: On this Git version, `git diff --no-index --label` exits with code 129 (unsupported option combination), causing empty delta patch output and full-view fallback.
  Evidence: Reproduced in Node REPL while diffing baseline/current temp files; changing to `--src-prefix/--dst-prefix` plus header normalization produced valid `@@` hunks.

## Decision Log

- Decision: Implement a linear snapshot model keyed by current diff payload rather than a revision DAG.
  Rationale: The target workflow is iterative agent updates; linear checkpoints satisfy the use case with far lower complexity and match the agreed scope boundaries.
  Date/Author: 2026-03-14 / Pi

- Decision: Store review state server-side in `~/.plannotator/review-state` instead of cookies.
  Rationale: Cookies are too small for durable per-file baseline content needed to compute “new changes since last review.” Server-side JSON keeps state portable across random ports and robust to larger diffs.
  Date/Author: 2026-03-14 / Pi

- Decision: Compute rereview patches by diffing stored baseline file content against current file content.
  Rationale: This gives “only newly changed lines” behavior for the linear workflow without implementing hard line-anchor remapping or rebase semantics.
  Date/Author: 2026-03-14 / Pi

- Decision: Keep v1 keyed by reviewer identity + file path + diff scope, without rename remapping.
  Rationale: Rename/remap fidelity is explicitly out-of-scope for v1 and can be added later with anchor fingerprints.
  Date/Author: 2026-03-14 / Pi

- Decision: If a requested delta view cannot produce a meaningful hunk (`@@`), return full patch mode from `/api/review/file-view`.
  Rationale: This avoids rendering an effectively empty/ambiguous patch and keeps reviewer navigation predictable.
  Date/Author: 2026-03-14 / Pi

- Decision: Disable expandable-context fetches in delta mode (`skipContextFetch`) instead of attempting to remap baseline-vs-current synthetic hunks onto git-side old/new context.
  Rationale: Delta patches compare checkpoint baseline content to current content, which may not match `/api/file-content`’s git old/new pair; disabling this path avoids incorrect expansion behavior in v1.
  Date/Author: 2026-03-14 / Pi

- Decision: Mirror the review checkpoint endpoints in `apps/pi-extension/server.ts` instead of trying to import Bun-specific `packages/server/review.ts`.
  Rationale: Pi extension is loaded via Node/jiti and cannot rely on Bun server/runtime APIs; Node route parity keeps feature behavior consistent across runtimes.
  Date/Author: 2026-03-14 / Pi

## Outcomes & Retrospective

Milestones 1 through 3 are functionally implemented in code and validated with focused automated checks plus API smoke runs. The server now persists snapshots/checkpoints and derives per-file review state; the review editor now surfaces status chips and explicit file-level actions (`Review new changes`, `Review all changes`, `Mark reviewed`, `Skip for now`, `Reset`). Delta view defaults for `needs-rereview` files and falls back to full mode when a delta patch is not meaningful.

A runtime parity gap was also resolved: Pi extension’s Node server now implements the same review checkpoint endpoints, so these controls work in Pi sessions (not only in Bun-backed review/hook servers).

What remains is the full manual acceptance loop exactly as written in this ExecPlan (two sequential review sessions with intervening file edits, plus explicit confirmation of skip/reset behavior in the live UI). That validation was left incomplete in this session to keep implementation momentum and test/build verification tight.

## Context and Orientation

The review UI entry point is `packages/review-editor/App.tsx`. It fetches `/api/diff`, parses unified diff text into file records, renders the file tree via `packages/review-editor/components/FileTree.tsx`, and renders the active patch via `packages/review-editor/components/DiffViewer.tsx`.

`packages/server/review.ts` serves the review API and currently tracks mutable diff state only in process memory (`currentPatch`, `currentDiffType`). It does not persist reviewer/file review state. `packages/server/git.ts` provides both diff generation and `getFileContentsForDiff()`, which is the key primitive for building “delta since last reviewed checkpoint” patches.

A “snapshot” in this plan means one concrete reviewable diff context produced by the server at a point in time, represented by a stable identifier and per-file patch hashes. A “checkpoint” means one reviewer’s stored decision for one file at one snapshot (`reviewed` or `skipped`). “Delta view” means a synthetic patch between the file content captured at the reviewer’s checkpoint and the file content in the current snapshot.

## Milestones

### Milestone 1: Add snapshot/checkpoint persistence and server APIs

At the end of this milestone, the server can persist per-reviewer file checkpoints, derive file statuses for the current snapshot, and return full or delta patch text for a file. No UI wiring is required yet beyond temporary endpoint-level verification.

Create `packages/server/review-state.ts` and define filesystem-backed storage under `~/.plannotator/review-state/{project}/`. Store two JSON concepts: snapshot records and reviewer checkpoints. Snapshot records capture file patch hashes and baseline file content for the current diff. Reviewer checkpoints capture `reviewed` or `skipped` at a specific snapshot/patch. Use safe JSON read/write with corruption fallback (invalid JSON yields empty state and writes a `.corrupt-<timestamp>.json` copy before reset).

Extend `packages/server/review.ts` with new endpoints:

- `GET /api/review/state?reviewerId=<id>` returns current snapshot metadata plus per-file derived status (`unreviewed`, `reviewed`, `needs-rereview`, `skipped`) and whether delta view is available.
- `POST /api/review/checkpoint` with `{ reviewerId, filePath, oldPath?, action }` where `action` is `mark-reviewed`, `skip`, or `reset`.
- `POST /api/review/file-view` with `{ reviewerId, filePath, oldPath?, viewMode }` where `viewMode` is `full` or `delta`, returning the patch text to render.

Use the existing in-memory `currentPatch/currentDiffType` state in `review.ts` for live context. Parse the current patch into file chunks on the server, compute patch hashes, and materialize a snapshot record lazily when state is requested or a checkpoint is written.

Use `diff` package patch generation for delta output to produce a unified patch string that `@pierre/diffs` can render.

Milestone 1 verification is endpoint-level: run targeted tests and a small server smoke check to prove state survives server restart.

### Milestone 2: Wire review statuses and actions into the review editor

At the end of this milestone, the UI shows file review statuses, defaults to delta view when rereview is needed, supports switching to full view, and lets the reviewer mark reviewed/skip/reset at file level.

In `packages/review-editor/App.tsx`, add state for server-backed review status and active per-file view mode. After loading `/api/diff` (and after `/api/diff/switch`), call `/api/review/state` using current reviewer identity from `getIdentity()`. Derive the default file-open behavior exactly as follows:

- No checkpoint: open full current patch.
- `skipped`: open full current patch.
- `needs-rereview`: default to delta patch from `/api/review/file-view` with `viewMode: "delta"`.
- `reviewed`: open full current patch and show reviewed badge.

Add explicit file actions in the header area (replace or supersede the current “Viewed” control):

- `Review new changes` (delta mode when available).
- `Review all changes` (full mode).
- `Mark reviewed at this revision`.
- `Skip for now`.
- `Reset review state`.

Update `packages/review-editor/components/FileTree.tsx` and `FileTreeNode.tsx` to display a status chip per file (`unreviewed`, `reviewed`, `needs rereview`, `skipped`). Keep annotation counts and staging indicators intact. Update styling in `packages/review-editor/index.css` for the four statuses with clear visual contrast.

Milestone 2 verification is UI behavior in a real review session across two runs: first mark reviewed, then modify file and re-open review to see `needs rereview` and default delta.

### Milestone 3: Harden, test, and document behavior boundaries

At the end of this milestone, automated tests cover status derivation/storage behavior, and docs/notes explain scope limits (linear snapshots, no rename remapping) so future work does not over-assume v1 semantics.

Add focused tests in `packages/server/review-state.test.ts` for:

- `unreviewed` when no checkpoint exists.
- `reviewed` when current patch hash matches checkpoint hash.
- `needs-rereview` when patch hash changed from last reviewed checkpoint.
- `skipped` persistence behavior.
- Corrupt JSON recovery.
- Delta patch generation for modified, new, and deleted file cases.

Add a short developer note in `AGENTS.md` or `README.md` review section documenting that v1 rereview semantics are snapshot/content based and not Reviewable-grade remapping.

## Plan of Work

Start with backend primitives so UI wiring has deterministic contracts. Implement server storage and derivation logic first, including a pure function for status derivation and a pure function for building delta patch text from baseline and current content. These pure functions are the test anchor for milestone 1.

Next, add `review.ts` routes that translate HTTP requests into these pure operations. Keep all mutations behind explicit endpoints so state changes are easy to reason about and test. Ensure that changing diff view (`/api/diff/switch`) invalidates any file-view cache on the client by including snapshot metadata in `/api/review/state` responses.

Then update the React app to consume review-state APIs. Keep existing annotation flow untouched. The only patch-rendering change should be selecting which patch text (`full` or `delta`) is passed into `DiffViewer` for the active file.

Finally, add tests and run build validation for the reviewed apps (`apps/review`, `apps/hook`, and `apps/opencode-plugin`) because review-editor changes are embedded into built single-file artifacts consumed by multiple runtimes.

## Concrete Steps

Run all commands from repository root `./` unless explicitly noted.

1. Implement backend model and tests.

    bun test packages/server/storage.test.ts
    bun test packages/server/review-state.test.ts

Expected shape after `review-state.test.ts` is added:

    bun test v1.x.x
    packages/server/review-state.test.ts:
    (pass) deriveFileStatus > returns unreviewed when no checkpoint exists
    (pass) deriveFileStatus > returns reviewed when patch hash matches
    (pass) deriveFileStatus > returns needs-rereview when patch hash changed
    (pass) checkpoint storage > persists reviewed and skipped states
    (pass) checkpoint storage > recovers from corrupt JSON safely
    (pass) buildDeltaPatch > handles modified/new/deleted file baselines

2. Implement server route wiring and verify typecheck/build.

    bun run build:review

Expected:

    vite v6.x building for production...
    ✓ built in <time>

3. Wire review-editor UI controls and status badges, then rebuild embedded artifacts.

    bun run build:review
    bun run build:hook
    bun run build:opencode

Expected:

    ✓ @plannotator/review build complete
    ✓ @plannotator/hook build complete
    ✓ @plannotator/opencode-plugin build complete

4. Manual acceptance loop in a real repo state.

    bun run apps/review/server/index.ts

In the opened UI, perform this sequence:

- Open a changed file and click “Mark reviewed at this revision.”
- Submit/close the session.
- Make additional edits to the same file in terminal.
- Run `bun run apps/review/server/index.ts` again.
- Confirm file shows `needs rereview` in file tree.
- Open it and confirm default view is “Review new changes.”
- Toggle to “Review all changes” and confirm full patch appears.
- For another file, click “Skip for now,” close, and re-open; confirm status `skipped` and default full view.

## Validation and Acceptance

Acceptance is behavioral and must match this exact loop for the same reviewer identity:

1. In snapshot A, reviewer marks file `X` reviewed.
2. Agent modifies file `X` again, producing snapshot B.
3. In snapshot B, file `X` is labeled `needs rereview`.
4. Opening file `X` defaults to delta view (only changes introduced after snapshot A’s checkpoint).
5. Reviewer can switch file `X` to full current diff.
6. Reviewer can mark file `Y` as skipped.
7. On next snapshot, file `Y` remains `skipped` and opens in full diff mode by default.
8. Resetting file `Y` returns it to `unreviewed` behavior.

Also run automated checks for all new server-side logic and confirm no regression in existing review build outputs.

## Idempotence and Recovery

The implementation must be safe to rerun and recover:

- Re-running the same review session should not duplicate checkpoints; writing `mark-reviewed` twice for identical patch hash should be a no-op update.
- Resetting one file must not affect other files’ checkpoints.
- If review-state JSON is missing, treat as empty state and recreate.
- If review-state JSON is malformed, preserve a timestamped corrupt copy and continue with empty state.
- Recovery command for developers: remove `~/.plannotator/review-state/<project>/` to fully reset all review checkpoints for that project.

## Artifacts and Notes

Persisted checkpoint example (illustrative):

    {
      "reviewerId": "swift-falcon-tater",
      "filePath": "packages/review-editor/App.tsx",
      "status": "reviewed",
      "snapshotId": "rev_9f3a2c1b",
      "patchHash": "h_2b98f3f0",
      "updatedAt": "2026-03-14T22:30:00.000Z"
    }

Derived status example (illustrative):

    {
      "filePath": "packages/review-editor/App.tsx",
      "status": "needs-rereview",
      "lastCheckpointAt": "2026-03-14T22:30:00.000Z",
      "deltaAvailable": true
    }

Validation snippets captured during implementation:

    $ bun test packages/server/review-state.test.ts
    6 pass
    0 fail

    $ bun run build:review
    vite v6.4.1 building for production...
    ✓ built in 2.16s

    $ bun run build:hook
    vite v6.4.1 building for production...
    ✓ built in 4.58s

    $ bun run build:opencode
    Bundled 42 modules in 56ms

## Interfaces and Dependencies

Define and use these interfaces so server and UI share explicit contracts.

In `packages/shared/types.ts`, add:

    export type FileReviewStatus = "unreviewed" | "reviewed" | "needs-rereview" | "skipped";
    export type FileCheckpointAction = "mark-reviewed" | "skip" | "reset";
    export type FileViewMode = "full" | "delta";

    export interface FileReviewState {
      filePath: string;
      status: FileReviewStatus;
      patchHash: string;
      deltaAvailable: boolean;
      lastCheckpointAt?: string;
    }

    export interface ReviewSnapshotMeta {
      snapshotId: string;
      diffType: string;
      gitRef: string;
      baseId: string;
      headId: string;
      createdAt: string;
    }

    export interface ReviewStateResponse {
      snapshot: ReviewSnapshotMeta;
      files: FileReviewState[];
    }

In `packages/server/review-state.ts`, define:

    export function getReviewState(project: string, reviewerId: string, snapshot: ReviewSnapshotMeta, files: CurrentDiffFile[]): ReviewStateResponse;
    export function applyCheckpointAction(input: {
      project: string;
      reviewerId: string;
      filePath: string;
      oldPath?: string;
      action: FileCheckpointAction;
      snapshot: ReviewSnapshotMeta;
      currentFile: CurrentDiffFile;
      baselineNewContent: string | null;
    }): FileReviewState;
    export function buildDeltaPatch(input: {
      filePath: string;
      baselineNewContent: string | null;
      currentNewContent: string | null;
    }): string;

Dependencies to use:

- Existing `diff` package for unified patch creation.
- Existing `getFileContentsForDiff()` from `packages/server/git.ts` for baseline/current content lookups.
- Existing identity source `getIdentity()` in `packages/ui/utils/identity.ts` for reviewer ID.

Do not add new external dependencies for v1.

---

Plan Revision Note (2026-03-14, Pi): Initial ExecPlan created from handoff context plus repository inspection, with explicit linear snapshot/checkpoint scope and implementation milestones aligned to `PLANS.md` requirements.

Plan Revision Note (2026-03-14, Pi): Updated all living sections after implementing backend checkpoint persistence, review UI status/actions, tests, build validation, and API smoke verification; left the full manual two-session UI acceptance loop explicitly pending to keep plan state accurate.
