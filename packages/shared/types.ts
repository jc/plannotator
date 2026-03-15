// Editor annotations from VS Code extension (ephemeral, in-memory only)
export interface EditorAnnotation {
  id: string;
  filePath: string;     // workspace-relative (e.g., "src/auth.ts")
  selectedText: string;
  lineStart: number;    // 1-based
  lineEnd: number;      // 1-based
  comment?: string;
  createdAt: number;
}

// Git diff types shared between server and client
export interface DiffOption {
  id: string;
  label: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

export interface GitContext {
  currentBranch: string;
  defaultBranch: string;
  diffOptions: DiffOption[];
  worktrees: WorktreeInfo[];
}

// Review checkpoint types shared between review server and review editor
export type FileReviewStatus = "unreviewed" | "reviewed" | "needs-rereview" | "skipped";
export type FileCheckpointAction = "mark-reviewed" | "skip" | "reset";
export type FileViewMode = "full" | "delta";

export interface FileReviewState {
  filePath: string;
  oldPath?: string;
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
