import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ReviewSnapshotMeta } from "@plannotator/shared/types";
import {
  applyCheckpointAction,
  buildDeltaPatch,
  ensureSnapshotRecord,
  getFileRevisionStrip,
  getReviewState,
  hashPatch,
  resolveFileRevisionSnapshot,
  type CurrentDiffFile,
} from "./review-state";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-review-state-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSnapshot(overrides: Partial<ReviewSnapshotMeta> = {}): ReviewSnapshotMeta {
  return {
    snapshotId: "rev_test",
    diffType: "uncommitted",
    gitRef: "Uncommitted changes",
    baseId: "base123",
    headId: "head123",
    createdAt: "2026-03-14T22:30:00.000Z",
    ...overrides,
  };
}

function makeFile(path: string, patch: string, oldPath?: string): CurrentDiffFile {
  return {
    filePath: path,
    oldPath,
    patch,
    patchHash: hashPatch(patch),
  };
}

describe("getReviewState", () => {
  test("returns unreviewed when no checkpoint exists", () => {
    const rootDir = makeTempDir();
    const snapshot = makeSnapshot();
    const file = makeFile(
      "packages/review-editor/App.tsx",
      "diff --git a/packages/review-editor/App.tsx b/packages/review-editor/App.tsx\n"
    );

    const state = getReviewState(
      "plannotator",
      "swift-falcon-tater",
      snapshot,
      [file],
      { rootDir }
    );

    expect(state.files).toHaveLength(1);
    expect(state.files[0].status).toBe("unreviewed");
    expect(state.files[0].deltaAvailable).toBe(false);
  });

  test("returns reviewed when patch hash matches checkpoint", () => {
    const rootDir = makeTempDir();
    const snapshot = makeSnapshot();
    const file = makeFile(
      "packages/review-editor/App.tsx",
      "diff --git a/packages/review-editor/App.tsx b/packages/review-editor/App.tsx\n@@ -1 +1 @@\n-a\n+b\n"
    );

    applyCheckpointAction({
      project: "plannotator",
      reviewerId: "swift-falcon-tater",
      filePath: file.filePath,
      action: "mark-reviewed",
      snapshot,
      currentFile: file,
      baselineNewContent: "b\n",
      rootDir,
    });

    const state = getReviewState(
      "plannotator",
      "swift-falcon-tater",
      snapshot,
      [file],
      { rootDir }
    );

    expect(state.files[0].status).toBe("reviewed");
    expect(state.files[0].deltaAvailable).toBe(false);
  });

  test("returns needs-rereview when patch hash changed", () => {
    const rootDir = makeTempDir();
    const snapshot = makeSnapshot();
    const reviewedFile = makeFile(
      "packages/review-editor/App.tsx",
      "diff --git a/packages/review-editor/App.tsx b/packages/review-editor/App.tsx\n@@ -1 +1 @@\n-a\n+b\n"
    );

    applyCheckpointAction({
      project: "plannotator",
      reviewerId: "swift-falcon-tater",
      filePath: reviewedFile.filePath,
      action: "mark-reviewed",
      snapshot,
      currentFile: reviewedFile,
      baselineNewContent: "b\n",
      rootDir,
    });

    const changedFile = makeFile(
      "packages/review-editor/App.tsx",
      "diff --git a/packages/review-editor/App.tsx b/packages/review-editor/App.tsx\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"
    );

    const state = getReviewState(
      "plannotator",
      "swift-falcon-tater",
      snapshot,
      [changedFile],
      { rootDir }
    );

    expect(state.files[0].status).toBe("needs-rereview");
    expect(state.files[0].deltaAvailable).toBe(true);
  });

  test("persists skipped status across later patch changes", () => {
    const rootDir = makeTempDir();
    const snapshot = makeSnapshot();
    const file = makeFile(
      "packages/review-editor/App.tsx",
      "diff --git a/packages/review-editor/App.tsx b/packages/review-editor/App.tsx\n@@ -1 +1 @@\n-a\n+b\n"
    );

    applyCheckpointAction({
      project: "plannotator",
      reviewerId: "swift-falcon-tater",
      filePath: file.filePath,
      action: "skip",
      snapshot,
      currentFile: file,
      baselineNewContent: "b\n",
      rootDir,
    });

    const changedFile = makeFile(
      "packages/review-editor/App.tsx",
      "diff --git a/packages/review-editor/App.tsx b/packages/review-editor/App.tsx\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"
    );

    const state = getReviewState(
      "plannotator",
      "swift-falcon-tater",
      snapshot,
      [changedFile],
      { rootDir }
    );

    expect(state.files[0].status).toBe("skipped");
    expect(state.files[0].deltaAvailable).toBe(false);
  });

  test("recovers from corrupt JSON safely", () => {
    const rootDir = makeTempDir();
    const project = "plannotator";
    const snapshot = makeSnapshot();
    const file = makeFile(
      "packages/review-editor/App.tsx",
      "diff --git a/packages/review-editor/App.tsx b/packages/review-editor/App.tsx\n"
    );

    const projectDir = join(rootDir, project);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "checkpoints.json"), "{ invalid json", "utf-8");

    const state = getReviewState(project, "swift-falcon-tater", snapshot, [file], { rootDir });

    expect(state.files[0].status).toBe("unreviewed");

    const entries = readdirSync(projectDir);
    expect(entries.some((entry) => entry.startsWith("checkpoints.json.corrupt-"))).toBe(true);

    const rewritten = JSON.parse(readFileSync(join(projectDir, "checkpoints.json"), "utf-8"));
    expect(rewritten).toEqual({ checkpoints: {} });
  });
});

describe("file revision strip", () => {
  test("pins current snapshot as strip head", () => {
    const rootDir = makeTempDir();
    const project = "plannotator";
    const filePath = "src/review.ts";

    const olderCurrent = makeSnapshot({
      snapshotId: "rev_current",
      createdAt: "2026-03-14T21:00:00.000Z",
    });
    const newerHistorical = makeSnapshot({
      snapshotId: "rev_newer",
      createdAt: "2026-03-14T22:00:00.000Z",
    });

    ensureSnapshotRecord({
      project,
      snapshot: olderCurrent,
      files: [{
        filePath,
        patch: "diff --git a/src/review.ts b/src/review.ts\n",
        patchHash: hashPatch("cur"),
        baselineNewContent: "current\n",
      }],
      rootDir,
    });

    ensureSnapshotRecord({
      project,
      snapshot: newerHistorical,
      files: [{
        filePath,
        patch: "diff --git a/src/review.ts b/src/review.ts\n",
        patchHash: hashPatch("newer"),
        baselineNewContent: "newer\n",
      }],
      rootDir,
    });

    const strip = getFileRevisionStrip({
      project,
      reviewerId: "swift-falcon-tater",
      snapshot: olderCurrent,
      filePath,
      rootDir,
    });

    expect(strip.headSnapshotId).toBe("rev_current");
    expect(strip.cells[strip.cells.length - 1]?.snapshotId).toBe("rev_current");
  });

  test("returns ordered cells and reviewed default floor", () => {
    const rootDir = makeTempDir();
    const project = "plannotator";

    const snapshot1 = makeSnapshot({
      snapshotId: "rev_001",
      createdAt: "2026-03-14T22:00:00.000Z",
    });
    const snapshot2 = makeSnapshot({
      snapshotId: "rev_002",
      createdAt: "2026-03-14T23:00:00.000Z",
    });

    const filePath = "src/review.ts";

    ensureSnapshotRecord({
      project,
      snapshot: snapshot1,
      files: [
        {
          filePath,
          patch: "diff --git a/src/review.ts b/src/review.ts\n@@ -1 +1 @@\n-a\n+b\n",
          patchHash: hashPatch("patch-1"),
          baselineNewContent: "export const version = 1;\n",
        },
      ],
      rootDir,
    });

    ensureSnapshotRecord({
      project,
      snapshot: snapshot2,
      files: [
        {
          filePath,
          patch: "diff --git a/src/review.ts b/src/review.ts\n@@ -1 +1 @@\n-b\n+c\n",
          patchHash: hashPatch("patch-2"),
          baselineNewContent: "export const version = 2;\n",
        },
      ],
      rootDir,
    });

    const currentFile = makeFile(filePath, "diff --git a/src/review.ts b/src/review.ts\n@@ -1 +1 @@\n-b\n+c\n");

    applyCheckpointAction({
      project,
      reviewerId: "swift-falcon-tater",
      filePath,
      action: "mark-reviewed",
      snapshot: snapshot2,
      currentFile,
      baselineNewContent: "export const version = 2;\n",
      checkpointSnapshotId: "rev_001",
      checkpointPatchHash: hashPatch("patch-1"),
      checkpointBaselineNewContent: "export const version = 1;\n",
      rootDir,
    });

    const strip = getFileRevisionStrip({
      project,
      reviewerId: "swift-falcon-tater",
      snapshot: snapshot2,
      filePath,
      rootDir,
    });

    expect(strip.cells).toHaveLength(2);
    expect(strip.cells[0].snapshotId).toBe("rev_001");
    expect(strip.cells[1].snapshotId).toBe("rev_002");
    expect(strip.headSnapshotId).toBe("rev_002");
    expect(strip.reviewedSnapshotId).toBe("rev_001");
    expect(strip.defaultFloorSnapshotId).toBe("rev_001");
  });

  test("resolves floor snapshot file for selected revision", () => {
    const rootDir = makeTempDir();
    const project = "plannotator";

    const snapshot = makeSnapshot({ snapshotId: "rev_floor" });
    ensureSnapshotRecord({
      project,
      snapshot,
      files: [
        {
          filePath: "src/review.ts",
          patch: "diff --git a/src/review.ts b/src/review.ts\n",
          patchHash: hashPatch("floor-patch"),
          baselineNewContent: "content\n",
        },
      ],
      rootDir,
    });

    const resolved = resolveFileRevisionSnapshot({
      project,
      snapshot,
      filePath: "src/review.ts",
      floorSnapshotId: "rev_floor",
      rootDir,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.file.patchHash).toBe(hashPatch("floor-patch"));
  });
});

describe("buildDeltaPatch", () => {
  test("handles modified, new, and deleted baselines", () => {
    const modified = buildDeltaPatch({
      filePath: "src/example.ts",
      baselineNewContent: "const a = 1;\n",
      currentNewContent: "const a = 2;\n",
    });

    expect(modified).toContain("diff --git a/src/example.ts b/src/example.ts");
    expect(modified).toContain("@@");
    expect(modified).toContain("-const a = 1;");
    expect(modified).toContain("+const a = 2;");

    const created = buildDeltaPatch({
      filePath: "src/new.ts",
      baselineNewContent: null,
      currentNewContent: "export const x = 1;\n",
    });

    expect(created).toContain("--- /dev/null");
    expect(created).toContain("+++ b/src/new.ts");

    const deleted = buildDeltaPatch({
      filePath: "src/old.ts",
      baselineNewContent: "export const y = 1;\n",
      currentNewContent: null,
    });

    expect(deleted).toContain("--- a/src/old.ts");
    expect(deleted).toContain("+++ /dev/null");
  });
});
