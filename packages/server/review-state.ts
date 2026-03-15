import { createHash } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { createTwoFilesPatch } from "diff";
import type {
  FileCheckpointAction,
  FileReviewState,
  FileReviewStatus,
  FileRevisionCell,
  FileRevisionStripResponse,
  ReviewSnapshotMeta,
  ReviewStateResponse,
} from "@plannotator/shared/types";

export interface CurrentDiffFile {
  filePath: string;
  oldPath?: string;
  patch: string;
  patchHash: string;
}

export interface PersistedSnapshotFile {
  filePath: string;
  oldPath?: string;
  patchHash: string;
  baselineNewContent: string | null;
}

export interface PersistedSnapshot extends ReviewSnapshotMeta {
  files: PersistedSnapshotFile[];
}

interface SnapshotStore {
  snapshots: Record<string, PersistedSnapshot>;
}

type CheckpointKind = "reviewed" | "skipped";

export interface ReviewCheckpoint {
  reviewerId: string;
  scope: string;
  filePath: string;
  oldPath?: string;
  status: CheckpointKind;
  snapshotId: string;
  patchHash: string;
  baselineNewContent?: string | null;
  updatedAt: string;
}

interface CheckpointStore {
  checkpoints: Record<string, ReviewCheckpoint>;
}

interface StorageOptions {
  rootDir?: string;
}

export function hashPatch(patch: string): string {
  return `h_${hashString(patch).slice(0, 12)}`;
}

export function getDiffFileKey(filePath: string, oldPath?: string): string {
  return `${oldPath || ""}::${filePath}`;
}

export function parseDiffToCurrentFiles(rawPatch: string): CurrentDiffFile[] {
  const files: CurrentDiffFile[] = [];
  const fileChunks = rawPatch.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split("\n");
    const headerMatch = lines[0]?.match(/^a\/(.+) b\/(.+)$/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];
    const patch = `diff --git ${chunk}`;

    files.push({
      filePath: newPath,
      oldPath: oldPath !== newPath ? oldPath : undefined,
      patch,
      patchHash: hashPatch(patch),
    });
  }

  return files;
}

export function buildSnapshotMeta(input: {
  rawPatch: string;
  diffType: string;
  gitRef: string;
}): ReviewSnapshotMeta {
  const { rawPatch, diffType, gitRef } = input;
  const sourceHash = hashString(`${diffType}\n${gitRef}\n${rawPatch}`);

  const indexMatches = Array.from(
    rawPatch.matchAll(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/gm)
  );

  const baseSeed =
    indexMatches.length > 0
      ? indexMatches.map((m) => m[1]).join("|")
      : `${sourceHash}:base`;
  const headSeed =
    indexMatches.length > 0
      ? indexMatches.map((m) => m[2]).join("|")
      : `${sourceHash}:head`;

  return {
    snapshotId: `rev_${sourceHash.slice(0, 12)}`,
    diffType,
    gitRef,
    baseId: hashString(baseSeed).slice(0, 12),
    headId: hashString(headSeed).slice(0, 12),
    createdAt: new Date().toISOString(),
  };
}

export function ensureSnapshotRecord(input: {
  project: string;
  snapshot: ReviewSnapshotMeta;
  files: Array<CurrentDiffFile & { baselineNewContent: string | null }>;
  rootDir?: string;
}): void {
  const { project, snapshot, files, rootDir } = input;
  const store = readSnapshotStore(project, { rootDir });
  const existing = store.snapshots[snapshot.snapshotId];

  if (existing) {
    return;
  }

  store.snapshots[snapshot.snapshotId] = {
    ...snapshot,
    files: files.map((file) => ({
      filePath: file.filePath,
      oldPath: file.oldPath,
      patchHash: file.patchHash,
      baselineNewContent: file.baselineNewContent,
    })),
  };

  writeSnapshotStore(project, store, { rootDir });
}

export function getReviewState(
  project: string,
  reviewerId: string,
  snapshot: ReviewSnapshotMeta,
  files: CurrentDiffFile[],
  options: StorageOptions = {}
): ReviewStateResponse {
  const scope = getScope(snapshot);
  const checkpointStore = readCheckpointStore(project, options);

  const states = files.map((file) => {
    const checkpoint = findCheckpoint(
      checkpointStore,
      reviewerId,
      scope,
      file.filePath,
      file.oldPath
    );

    const derived = deriveFileState(file, checkpoint);
    return {
      filePath: file.filePath,
      oldPath: file.oldPath,
      status: derived.status,
      patchHash: file.patchHash,
      deltaAvailable: derived.deltaAvailable,
      ...(checkpoint?.updatedAt ? { lastCheckpointAt: checkpoint.updatedAt } : {}),
    } satisfies FileReviewState;
  });

  return {
    snapshot,
    files: states,
  };
}

export function getCheckpointForFile(
  project: string,
  reviewerId: string,
  snapshot: ReviewSnapshotMeta,
  filePath: string,
  oldPath?: string,
  options: StorageOptions = {}
): ReviewCheckpoint | null {
  const checkpointStore = readCheckpointStore(project, options);
  return (
    findCheckpoint(
      checkpointStore,
      reviewerId,
      getScope(snapshot),
      filePath,
      oldPath
    ) || null
  );
}

export function applyCheckpointAction(input: {
  project: string;
  reviewerId: string;
  filePath: string;
  oldPath?: string;
  action: FileCheckpointAction;
  snapshot: ReviewSnapshotMeta;
  currentFile: CurrentDiffFile;
  baselineNewContent: string | null;
  checkpointSnapshotId?: string;
  checkpointPatchHash?: string;
  checkpointBaselineNewContent?: string | null;
  rootDir?: string;
}): FileReviewState {
  const {
    project,
    reviewerId,
    filePath,
    oldPath,
    action,
    snapshot,
    currentFile,
    baselineNewContent,
    checkpointSnapshotId,
    checkpointPatchHash,
    checkpointBaselineNewContent,
    rootDir,
  } = input;

  const options = { rootDir };
  const checkpointStore = readCheckpointStore(project, options);
  const scope = getScope(snapshot);
  const key = buildCheckpointKey(reviewerId, scope, filePath, oldPath);
  const existing = checkpointStore.checkpoints[key];
  let changed = false;

  if (action === "reset") {
    if (existing) {
      delete checkpointStore.checkpoints[key];
      changed = true;
    }
  } else if (action === "skip") {
    const next: ReviewCheckpoint = {
      reviewerId,
      scope,
      filePath,
      ...(oldPath ? { oldPath } : {}),
      status: "skipped",
      snapshotId: snapshot.snapshotId,
      patchHash: currentFile.patchHash,
      updatedAt: new Date().toISOString(),
    };

    if (!existing || !isCheckpointEquivalent(existing, next)) {
      checkpointStore.checkpoints[key] = next;
      changed = true;
    }
  } else {
    const next: ReviewCheckpoint = {
      reviewerId,
      scope,
      filePath,
      ...(oldPath ? { oldPath } : {}),
      status: "reviewed",
      snapshotId: checkpointSnapshotId || snapshot.snapshotId,
      patchHash: checkpointPatchHash || currentFile.patchHash,
      baselineNewContent:
        checkpointBaselineNewContent !== undefined
          ? checkpointBaselineNewContent
          : baselineNewContent,
      updatedAt: new Date().toISOString(),
    };

    if (!existing || !isCheckpointEquivalent(existing, next)) {
      checkpointStore.checkpoints[key] = next;
      changed = true;
    }
  }

  if (changed) {
    writeCheckpointStore(project, checkpointStore, options);
  }

  const checkpoint = checkpointStore.checkpoints[key];
  const derived = deriveFileState(currentFile, checkpoint);

  return {
    filePath: currentFile.filePath,
    oldPath: currentFile.oldPath,
    status: derived.status,
    patchHash: currentFile.patchHash,
    deltaAvailable: derived.deltaAvailable,
    ...(checkpoint?.updatedAt ? { lastCheckpointAt: checkpoint.updatedAt } : {}),
  };
}

export function buildDeltaPatch(input: {
  filePath: string;
  baselineNewContent: string | null;
  currentNewContent: string | null;
}): string {
  const { filePath, baselineNewContent, currentNewContent } = input;

  const diffGitLeft = `a/${filePath}`;
  const diffGitRight = `b/${filePath}`;
  const oldLabel = baselineNewContent === null ? "/dev/null" : diffGitLeft;
  const newLabel = currentNewContent === null ? "/dev/null" : diffGitRight;
  const oldText = baselineNewContent ?? "";
  const newText = currentNewContent ?? "";

  const unified = createTwoFilesPatch(
    oldLabel,
    newLabel,
    oldText,
    newText,
    "",
    "",
    { context: 3 }
  );

  const lines = unified.split("\n");

  let normalizedLines = lines;
  if (normalizedLines[0]?.startsWith("Index: ")) {
    normalizedLines = normalizedLines.slice(2);
  } else if (normalizedLines[0] === "===================================================================") {
    normalizedLines = normalizedLines.slice(1);
  }

  normalizedLines = normalizedLines.map((line) => {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      return line.split("\t")[0];
    }
    return line;
  });

  return `diff --git ${diffGitLeft} ${diffGitRight}\n${normalizedLines.join("\n")}`;
}

export function listSnapshots(project: string, options: StorageOptions = {}): PersistedSnapshot[] {
  return Object.values(readSnapshotStore(project, options).snapshots);
}

export function buildNoChangesPatch(filePath: string, currentNewContent: string | null): string {
  const diffGitLeft = `a/${filePath}`;
  const diffGitRight = `b/${filePath}`;
  const oldLabel = currentNewContent === null ? "/dev/null" : diffGitLeft;
  const newLabel = currentNewContent === null ? "/dev/null" : diffGitRight;
  return `diff --git ${diffGitLeft} ${diffGitRight}\n--- ${oldLabel}\n+++ ${newLabel}\n`;
}

export function getFileRevisionStrip(input: {
  project: string;
  reviewerId: string;
  snapshot: ReviewSnapshotMeta;
  filePath: string;
  oldPath?: string;
  rootDir?: string;
}): FileRevisionStripResponse {
  const { project, reviewerId, snapshot, filePath, oldPath, rootDir } = input;
  const options = { rootDir };
  const snapshotStore = readSnapshotStore(project, options);
  const checkpointStore = readCheckpointStore(project, options);
  const scope = getScope(snapshot);

  const scopedSnapshots = Object.values(snapshotStore.snapshots)
    .filter((candidate) => getScope(candidate) === scope)
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.snapshotId.localeCompare(b.snapshotId);
      return a.createdAt.localeCompare(b.createdAt);
    });

  const rawCells: Array<FileRevisionCell & { baselineNewContent: string | null }> = [];

  for (const scopedSnapshot of scopedSnapshots) {
    const file = findSnapshotFile(scopedSnapshot, filePath, oldPath);
    if (!file) continue;

    const previous = rawCells[rawCells.length - 1];
    if (previous && previous.patchHash === file.patchHash) {
      continue;
    }

    rawCells.push({
      snapshotId: scopedSnapshot.snapshotId,
      patchHash: file.patchHash,
      createdAt: scopedSnapshot.createdAt,
      order: rawCells.length,
      baselineNewContent: file.baselineNewContent,
    });
  }

  const currentIndex = rawCells.findIndex((cell) => cell.snapshotId === snapshot.snapshotId);
  if (currentIndex >= 0 && currentIndex !== rawCells.length - 1) {
    const [currentCell] = rawCells.splice(currentIndex, 1);
    rawCells.push(currentCell);
  }

  const cells = rawCells.map(({ baselineNewContent: _ignored, ...cell }) => cell);
  const headCell = rawCells[rawCells.length - 1];

  const checkpoint = findCheckpoint(
    checkpointStore,
    reviewerId,
    scope,
    filePath,
    oldPath
  );

  let reviewedSnapshotId: string | undefined;
  if (checkpoint && checkpoint.status === "reviewed") {
    const direct = rawCells.find((cell) => cell.snapshotId === checkpoint.snapshotId);
    if (direct) {
      reviewedSnapshotId = direct.snapshotId;
    } else {
      for (let i = rawCells.length - 1; i >= 0; i -= 1) {
        if (rawCells[i].patchHash === checkpoint.patchHash) {
          reviewedSnapshotId = rawCells[i].snapshotId;
          break;
        }
      }
    }
  }

  const defaultFloorSnapshotId = reviewedSnapshotId;

  const headSnapshotId = headCell?.snapshotId || snapshot.snapshotId;

  return {
    snapshot,
    filePath,
    ...(oldPath ? { oldPath } : {}),
    headSnapshotId,
    ...(reviewedSnapshotId ? { reviewedSnapshotId } : {}),
    ...(defaultFloorSnapshotId ? { defaultFloorSnapshotId } : {}),
    defaultCeilingSnapshotId: headSnapshotId,
    cells,
  };
}

export function resolveFileRevisionSnapshot(input: {
  project: string;
  snapshot: ReviewSnapshotMeta;
  filePath: string;
  oldPath?: string;
  floorSnapshotId: string;
  rootDir?: string;
}): { snapshot: PersistedSnapshot; file: PersistedSnapshotFile } | null {
  const { project, snapshot, filePath, oldPath, floorSnapshotId, rootDir } = input;
  const store = readSnapshotStore(project, { rootDir });
  const scopedSnapshot = store.snapshots[floorSnapshotId];

  if (!scopedSnapshot) {
    return null;
  }

  if (getScope(scopedSnapshot) !== getScope(snapshot)) {
    return null;
  }

  const file = findSnapshotFile(scopedSnapshot, filePath, oldPath);
  if (!file) {
    return null;
  }

  return { snapshot: scopedSnapshot, file };
}

function findSnapshotFile(
  snapshot: PersistedSnapshot,
  filePath: string,
  oldPath?: string,
): PersistedSnapshotFile | undefined {
  if (oldPath) {
    return snapshot.files.find(
      (file) => file.filePath === filePath && file.oldPath === oldPath
    );
  }

  return (
    snapshot.files.find((file) => file.filePath === filePath) ||
    snapshot.files.find((file) => file.filePath === filePath && !file.oldPath)
  );
}

function deriveFileState(
  file: CurrentDiffFile,
  checkpoint?: ReviewCheckpoint
): { status: FileReviewStatus; deltaAvailable: boolean } {
  if (!checkpoint) {
    return { status: "unreviewed", deltaAvailable: false };
  }

  if (checkpoint.status === "skipped") {
    return { status: "skipped", deltaAvailable: false };
  }

  if (checkpoint.patchHash === file.patchHash) {
    return { status: "reviewed", deltaAvailable: false };
  }

  return {
    status: "needs-rereview",
    deltaAvailable: Object.prototype.hasOwnProperty.call(
      checkpoint,
      "baselineNewContent"
    ),
  };
}

function isCheckpointEquivalent(a: ReviewCheckpoint, b: ReviewCheckpoint): boolean {
  return (
    a.reviewerId === b.reviewerId &&
    a.scope === b.scope &&
    a.filePath === b.filePath &&
    a.oldPath === b.oldPath &&
    a.status === b.status &&
    a.snapshotId === b.snapshotId &&
    a.patchHash === b.patchHash &&
    a.baselineNewContent === b.baselineNewContent
  );
}

function getScope(snapshot: ReviewSnapshotMeta): string {
  return `${snapshot.diffType}::${snapshot.gitRef}`;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeProject(project: string): string {
  const sanitized = project.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "default";
}

function getReviewStateRoot(rootDir?: string): string {
  const dir = rootDir || join(homedir(), ".plannotator", "review-state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getProjectDir(project: string, options: StorageOptions = {}): string {
  const dir = join(getReviewStateRoot(options.rootDir), sanitizeProject(project));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function snapshotsPath(project: string, options: StorageOptions = {}): string {
  return join(getProjectDir(project, options), "snapshots.json");
}

function checkpointsPath(project: string, options: StorageOptions = {}): string {
  return join(getProjectDir(project, options), "checkpoints.json");
}

function readSnapshotStore(
  project: string,
  options: StorageOptions = {}
): SnapshotStore {
  return readJsonWithRecovery<SnapshotStore>(
    snapshotsPath(project, options),
    () => ({ snapshots: {} })
  );
}

function writeSnapshotStore(
  project: string,
  store: SnapshotStore,
  options: StorageOptions = {}
): void {
  writeJsonFile(snapshotsPath(project, options), store);
}

function readCheckpointStore(
  project: string,
  options: StorageOptions = {}
): CheckpointStore {
  return readJsonWithRecovery<CheckpointStore>(
    checkpointsPath(project, options),
    () => ({ checkpoints: {} })
  );
}

function writeCheckpointStore(
  project: string,
  store: CheckpointStore,
  options: StorageOptions = {}
): void {
  writeJsonFile(checkpointsPath(project, options), store);
}

function buildCheckpointKey(
  reviewerId: string,
  scope: string,
  filePath: string,
  oldPath?: string
): string {
  return `${reviewerId}::${scope}::${getDiffFileKey(filePath, oldPath)}`;
}

function findCheckpoint(
  store: CheckpointStore,
  reviewerId: string,
  scope: string,
  filePath: string,
  oldPath?: string
): ReviewCheckpoint | undefined {
  const exactKey = buildCheckpointKey(reviewerId, scope, filePath, oldPath);
  if (store.checkpoints[exactKey]) {
    return store.checkpoints[exactKey];
  }

  // Fallback if oldPath is missing: pick the latest checkpoint for filePath.
  if (!oldPath) {
    let latest: ReviewCheckpoint | undefined;
    const prefix = `${reviewerId}::${scope}::`;

    for (const [key, checkpoint] of Object.entries(store.checkpoints)) {
      if (!key.startsWith(prefix)) continue;
      if (checkpoint.filePath !== filePath) continue;
      if (!latest || checkpoint.updatedAt > latest.updatedAt) {
        latest = checkpoint;
      }
    }

    return latest;
  }

  return undefined;
}

function readJsonWithRecovery<T>(
  filePath: string,
  createFallback: () => T
): T {
  const fallback = createFallback();

  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const corruptPath = `${filePath}.corrupt-${timestamp}.json`;

    try {
      copyFileSync(filePath, corruptPath);
    } catch {
      // Ignore copy failures.
    }

    writeJsonFile(filePath, fallback);
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}
