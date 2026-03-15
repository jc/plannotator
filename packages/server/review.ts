/**
 * Code Review Server
 *
 * Provides a server implementation for code review with git diff rendering.
 * Follows the same patterns as the plan server.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote/devcontainer mode
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import { isRemoteSession, getServerPort } from "./remote";
import { type DiffType, type GitContext, runGitDiff, getFileContentsForDiff, gitAddFile, gitResetFile, parseWorktreeDiffType, validateFilePath } from "./git";
import { detectProjectName } from "./project";
import { getRepoInfo } from "./repo";
import {
  applyCheckpointAction,
  buildDeltaPatch,
  buildSnapshotMeta,
  ensureSnapshotRecord,
  getCheckpointForFile,
  getDiffFileKey,
  getReviewState,
  parseDiffToCurrentFiles,
  type CurrentDiffFile,
} from "./review-state";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { createEditorAnnotationHandler } from "./editor-annotations";
import type { FileCheckpointAction, FileViewMode, ReviewSnapshotMeta } from "@plannotator/shared/types";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { type DiffType, type DiffOption, type GitContext, type WorktreeInfo } from "./git";
export { handleServerReady as handleReviewServerReady } from "./shared-handlers";

// --- Types ---

export interface ReviewServerOptions {
  /** Raw git diff patch string */
  rawPatch: string;
  /** Git ref used for the diff (e.g., "HEAD", "main..HEAD", "--staged") */
  gitRef: string;
  /** Error message if git diff failed */
  error?: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Origin identifier for UI customization */
  origin?: "opencode" | "claude-code" | "pi";
  /** Current diff type being displayed */
  diffType?: DiffType;
  /** Git context with branch info and available diff options */
  gitContext?: GitContext;
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /** Custom base URL for share links (default: https://share.plannotator.ai) */
  shareBaseUrl?: string;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  /** OpenCode client for querying available agents (OpenCode only) */
  opencodeClient?: OpencodeClient;
}

export interface ReviewServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user feedback submission */
  waitForDecision: () => Promise<{
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

/**
 * Start the Code Review server
 *
 * Handles:
 * - Remote detection and port configuration
 * - API routes (/api/diff, /api/feedback)
 * - Port conflict retries
 */
export async function startReviewServer(
  options: ReviewServerOptions
): Promise<ReviewServerResult> {
  const { htmlContent, origin, gitContext, sharingEnabled = true, shareBaseUrl, onReady } = options;

  const draftKey = contentHash(options.rawPatch);
  const editorAnnotations = createEditorAnnotationHandler();

  // Mutable state for diff switching
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";
  let currentError = options.error;

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo();
  const detectedProject = await detectProjectName();
  const projectName = detectedProject || repoInfo?.display || "default";

  type ReviewContext = {
    snapshot: ReviewSnapshotMeta;
    files: CurrentDiffFile[];
    currentNewContentByKey: Map<string, string | null>;
  };

  let currentReviewContext: ReviewContext | null = null;

  const invalidateReviewContext = () => {
    currentReviewContext = null;
  };

  const getCurrentReviewContext = async (): Promise<ReviewContext> => {
    if (currentReviewContext) {
      return currentReviewContext;
    }

    const files = parseDiffToCurrentFiles(currentPatch);
    const snapshot = buildSnapshotMeta({
      rawPatch: currentPatch,
      diffType: currentDiffType,
      gitRef: currentGitRef,
    });
    const defaultBranch = gitContext?.defaultBranch || "main";

    const fileContentPairs = await Promise.all(
      files.map(async (file) => {
        const contents = await getFileContentsForDiff(
          currentDiffType,
          defaultBranch,
          file.filePath,
          file.oldPath,
        );

        return [
          getDiffFileKey(file.filePath, file.oldPath),
          contents.newContent,
        ] as const;
      })
    );

    const currentNewContentByKey = new Map<string, string | null>(fileContentPairs);

    ensureSnapshotRecord({
      project: projectName,
      snapshot,
      files: files.map((file) => ({
        ...file,
        baselineNewContent:
          currentNewContentByKey.get(getDiffFileKey(file.filePath, file.oldPath)) ?? null,
      })),
    });

    currentReviewContext = {
      snapshot,
      files,
      currentNewContentByKey,
    };

    return currentReviewContext;
  };

  const findCurrentFile = (
    files: CurrentDiffFile[],
    filePath: string,
    oldPath?: string
  ): CurrentDiffFile | undefined => {
    if (oldPath) {
      return files.find((file) => file.filePath === filePath && file.oldPath === oldPath);
    }
    return files.find((file) => file.filePath === filePath);
  };

  // Decision promise
  let resolveDecision: (result: {
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }) => void;
  const decisionPromise = new Promise<{
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }>((resolve) => {
    resolveDecision = resolve;
  });

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({
        port: configuredPort,

        async fetch(req) {
          const url = new URL(req.url);

          // API: Get diff content
          if (url.pathname === "/api/diff" && req.method === "GET") {
            return Response.json({
              rawPatch: currentPatch,
              gitRef: currentGitRef,
              origin,
              diffType: currentDiffType,
              gitContext,
              sharingEnabled,
              shareBaseUrl,
              repoInfo,
              ...(currentError && { error: currentError }),
            });
          }

          // API: Switch diff type
          if (url.pathname === "/api/diff/switch" && req.method === "POST") {
            try {
              const body = (await req.json()) as { diffType: DiffType };
              let newDiffType = body.diffType;

              if (!newDiffType) {
                return Response.json(
                  { error: "Missing diffType" },
                  { status: 400 }
                );
              }

              const defaultBranch = gitContext?.defaultBranch || "main";

              // Run the new diff
              const result = await runGitDiff(newDiffType, defaultBranch);

              // Update state
              currentPatch = result.patch;
              currentGitRef = result.label;
              currentDiffType = newDiffType;
              currentError = result.error;
              invalidateReviewContext();

              return Response.json({
                rawPatch: currentPatch,
                gitRef: currentGitRef,
                diffType: currentDiffType,
                ...(currentError && { error: currentError }),
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to switch diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Get file content for expandable diff context
          if (url.pathname === "/api/file-content" && req.method === "GET") {
            const filePath = url.searchParams.get("path");
            if (!filePath) {
              return Response.json({ error: "Missing path" }, { status: 400 });
            }
            try { validateFilePath(filePath); } catch {
              return Response.json({ error: "Invalid path" }, { status: 400 });
            }
            const oldPath = url.searchParams.get("oldPath") || undefined;
            if (oldPath) {
              try { validateFilePath(oldPath); } catch {
                return Response.json({ error: "Invalid path" }, { status: 400 });
              }
            }
            const defaultBranch = gitContext?.defaultBranch || "main";
            const result = await getFileContentsForDiff(
              currentDiffType,
              defaultBranch,
              filePath,
              oldPath,
            );
            return Response.json(result);
          }

          // API: Git add / reset (stage / unstage) a file
          if (url.pathname === "/api/git-add" && req.method === "POST") {
            try {
              const body = (await req.json()) as { filePath: string; undo?: boolean };
              if (!body.filePath) {
                return Response.json({ error: "Missing filePath" }, { status: 400 });
              }

              // Determine cwd for worktree support
              let cwd: string | undefined;
              if (currentDiffType.startsWith("worktree:")) {
                const parsed = parseWorktreeDiffType(currentDiffType);
                if (parsed) cwd = parsed.path;
              }

              if (body.undo) {
                await gitResetFile(body.filePath, cwd);
              } else {
                await gitAddFile(body.filePath, cwd);
              }

              return Response.json({ ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to git add";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Read review checkpoint state for current snapshot
          if (url.pathname === "/api/review/state" && req.method === "GET") {
            const reviewerId = url.searchParams.get("reviewerId")?.trim();
            if (!reviewerId) {
              return Response.json({ error: "Missing reviewerId" }, { status: 400 });
            }

            try {
              const context = await getCurrentReviewContext();
              const state = getReviewState(
                projectName,
                reviewerId,
                context.snapshot,
                context.files
              );
              return Response.json(state);
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to read review state";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Apply file checkpoint action (mark reviewed / skip / reset)
          if (url.pathname === "/api/review/checkpoint" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                reviewerId?: string;
                filePath?: string;
                oldPath?: string;
                action?: FileCheckpointAction;
              };

              const reviewerId = body.reviewerId?.trim();
              const filePath = body.filePath?.trim();
              const action = body.action;

              if (!reviewerId || !filePath || !action) {
                return Response.json({ error: "Missing reviewerId, filePath, or action" }, { status: 400 });
              }

              const validActions: FileCheckpointAction[] = ["mark-reviewed", "skip", "reset"];
              if (!validActions.includes(action)) {
                return Response.json({ error: "Invalid action" }, { status: 400 });
              }

              const context = await getCurrentReviewContext();
              const currentFile = findCurrentFile(context.files, filePath, body.oldPath);

              if (!currentFile) {
                return Response.json({ error: "File not found in current diff" }, { status: 404 });
              }

              const fileKey = getDiffFileKey(currentFile.filePath, currentFile.oldPath);
              const baselineNewContent =
                context.currentNewContentByKey.get(fileKey) ?? null;

              const fileState = applyCheckpointAction({
                project: projectName,
                reviewerId,
                filePath: currentFile.filePath,
                oldPath: currentFile.oldPath,
                action,
                snapshot: context.snapshot,
                currentFile,
                baselineNewContent,
              });

              return Response.json({
                snapshot: context.snapshot,
                file: fileState,
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to update review checkpoint";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Get patch text for a file in full or delta mode
          if (url.pathname === "/api/review/file-view" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                reviewerId?: string;
                filePath?: string;
                oldPath?: string;
                viewMode?: FileViewMode;
              };

              const reviewerId = body.reviewerId?.trim();
              const filePath = body.filePath?.trim();
              const viewMode = body.viewMode;

              if (!reviewerId || !filePath || !viewMode) {
                return Response.json({ error: "Missing reviewerId, filePath, or viewMode" }, { status: 400 });
              }

              if (viewMode !== "full" && viewMode !== "delta") {
                return Response.json({ error: "Invalid viewMode" }, { status: 400 });
              }

              const context = await getCurrentReviewContext();
              const currentFile = findCurrentFile(context.files, filePath, body.oldPath);

              if (!currentFile) {
                return Response.json({ error: "File not found in current diff" }, { status: 404 });
              }

              if (viewMode === "full") {
                return Response.json({
                  filePath: currentFile.filePath,
                  oldPath: currentFile.oldPath,
                  viewMode: "full" as const,
                  patch: currentFile.patch,
                  snapshotId: context.snapshot.snapshotId,
                });
              }

              const checkpoint = getCheckpointForFile(
                projectName,
                reviewerId,
                context.snapshot,
                currentFile.filePath,
                currentFile.oldPath,
              );

              if (!checkpoint || checkpoint.status !== "reviewed") {
                return Response.json({
                  filePath: currentFile.filePath,
                  oldPath: currentFile.oldPath,
                  viewMode: "full" as const,
                  patch: currentFile.patch,
                  snapshotId: context.snapshot.snapshotId,
                });
              }

              const fileKey = getDiffFileKey(currentFile.filePath, currentFile.oldPath);
              const currentNewContent = context.currentNewContentByKey.get(fileKey) ?? null;
              const baselineNewContent = checkpoint.baselineNewContent ?? null;

              if (checkpoint.patchHash === currentFile.patchHash) {
                return Response.json({
                  filePath: currentFile.filePath,
                  oldPath: currentFile.oldPath,
                  viewMode: "full" as const,
                  patch: currentFile.patch,
                  snapshotId: context.snapshot.snapshotId,
                });
              }

              const deltaPatch = buildDeltaPatch({
                filePath: currentFile.filePath,
                baselineNewContent,
                currentNewContent,
              });

              if (!deltaPatch.includes("@@")) {
                return Response.json({
                  filePath: currentFile.filePath,
                  oldPath: currentFile.oldPath,
                  viewMode: "full" as const,
                  patch: currentFile.patch,
                  snapshotId: context.snapshot.snapshotId,
                });
              }

              return Response.json({
                filePath: currentFile.filePath,
                oldPath: currentFile.oldPath,
                viewMode: "delta" as const,
                patch: deltaPatch,
                snapshotId: context.snapshot.snapshotId,
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to load file view";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            return handleImage(req);
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          // API: Get available agents (OpenCode only)
          if (url.pathname === "/api/agents") {
            return handleAgents(options.opencodeClient);
          }

          // API: Annotation draft persistence
          if (url.pathname === "/api/draft") {
            if (req.method === "POST") return handleDraftSave(req, draftKey);
            if (req.method === "DELETE") return handleDraftDelete(draftKey);
            return handleDraftLoad(draftKey);
          }

          // API: Editor annotations (VS Code extension)
          const editorResponse = await editorAnnotations.handle(req, url);
          if (editorResponse) return editorResponse;

          // API: Submit review feedback
          if (url.pathname === "/api/feedback" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                feedback: string;
                annotations: unknown[];
                agentSwitch?: string;
              };

              deleteDraft(draftKey);
              resolveDecision({
                feedback: body.feedback || "",
                annotations: body.annotations || [],
                agentSwitch: body.agentSwitch,
              });

              return Response.json({ ok: true });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to process feedback";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // Serve embedded HTML for all other routes (SPA)
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html" },
          });
        },
      });

      break; // Success, exit retry loop
    } catch (err: unknown) {
      const isAddressInUse =
        err instanceof Error && err.message.includes("EADDRINUSE");

      if (isAddressInUse && attempt < MAX_RETRIES) {
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }

      if (isAddressInUse) {
        const hint = isRemote ? " (set PLANNOTATOR_PORT to use different port)" : "";
        throw new Error(`Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`);
      }

      throw err;
    }
  }

  if (!server) {
    throw new Error("Failed to start server");
  }

  const serverUrl = `http://localhost:${server.port}`;

  // Notify caller that server is ready
  if (onReady) {
    onReady(serverUrl, isRemote, server.port);
  }

  return {
    port: server.port,
    url: serverUrl,
    isRemote,
    waitForDecision: () => decisionPromise,
    stop: () => server.stop(),
  };
}
