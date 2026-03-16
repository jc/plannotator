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

// Git review types shared between server and client
export type {
  DiffOption,
  WorktreeInfo,
  GitContext,
} from "./review-core";

// Review checkpoint types shared between review server and review editor
export type {
  FileReviewStatus,
  FileCheckpointAction,
  FileViewMode,
  FileReviewState,
  ReviewSnapshotMeta,
  ReviewStateResponse,
  FileRevisionCell,
  FileRevisionStripResponse,
} from "./review-state-core";
