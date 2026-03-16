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

import { createHash } from "crypto";
import { isRemoteSession, getServerPort } from "./remote";
import { type DiffType, type GitContext, runGitDiff, getFileContentsForDiff, gitAddFile, gitResetFile, parseWorktreeDiffType, validateFilePath } from "./git";
import { detectProjectName } from "./project";
import { getRepoInfo } from "./repo";
import {
  applyCheckpointAction,
  buildDeltaPatch,
  buildNoChangesPatch,
  buildSnapshotMeta,
  ensureSnapshotRecord,
  getCheckpointForFile,
  getDiffFileKey,
  getReviewState,
  parseDiffToCurrentFiles,
  type CurrentDiffFile,
} from "./review-state";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { createEditorAnnotationHandler } from "./editor-annotations";
import type { FileCheckpointAction, FileRevisionStripResponse, FileViewMode, ReviewSnapshotMeta } from "@plannotator/shared/types";

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
  /** Wait for user review decision */
  waitForDecision: () => Promise<{
    approved: boolean;
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

  type EffectiveDiffType = "uncommitted" | "staged" | "unstaged" | "last-commit" | "branch";
  const WORKING_REVISION_PREFIX = "wt:";

  const hashRevisionContent = (content: string | null): string => {
    const payload = content === null ? "__NULL__" : content;
    return `h_${createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
  };

  const getDiffExecutionContext = (): { cwd?: string; effectiveDiffType: EffectiveDiffType } => {
    if (!currentDiffType.startsWith("worktree:")) {
      return { effectiveDiffType: currentDiffType as EffectiveDiffType };
    }

    const parsed = parseWorktreeDiffType(currentDiffType);
    if (!parsed) {
      return { effectiveDiffType: "uncommitted" };
    }

    return { cwd: parsed.path, effectiveDiffType: parsed.subType as EffectiveDiffType };
  };

  const runGitCommand = async (args: string[], cwd?: string): Promise<{ stdout: string; exitCode: number }> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    return { stdout, exitCode };
  };

  const readContentAtRevision = async (
    revisionId: string,
    file: CurrentDiffFile,
  ): Promise<string | null | undefined> => {
    if (revisionId.startsWith(WORKING_REVISION_PREFIX)) {
      const context = await getCurrentReviewContext();
      return context.currentNewContentByKey.get(getDiffFileKey(file.filePath, file.oldPath)) ?? null;
    }

    const { cwd } = getDiffExecutionContext();

    const showPath = async (path: string): Promise<string | null> => {
      const result = await runGitCommand(["show", `${revisionId}:${path}`], cwd);
      if (result.exitCode === 0) {
        return result.stdout;
      }
      return null;
    };

    const direct = await showPath(file.filePath);
    if (direct !== null) {
      return direct;
    }

    if (file.oldPath && file.oldPath !== file.filePath) {
      return showPath(file.oldPath);
    }

    return undefined;
  };

  const getWorkingRevisionLabel = (effectiveDiffType: EffectiveDiffType): string =>
    effectiveDiffType === "staged" ? "Index" : "Working tree";

  const buildCommitRevisionStrip = async (
    reviewerId: string,
    file: CurrentDiffFile,
  ): Promise<FileRevisionStripResponse> => {
    const context = await getCurrentReviewContext();
    const { cwd, effectiveDiffType } = getDiffExecutionContext();
    const defaultBranch = gitContext?.defaultBranch || "main";

    const logArgs = ["log", "--follow", "--format=%H%x09%ct", "--reverse"];

    if (effectiveDiffType === "branch") {
      logArgs.push(`${defaultBranch}..HEAD`);
    } else if (effectiveDiffType === "last-commit") {
      const hasParent = await runGitCommand(["rev-parse", "--verify", "HEAD~1"], cwd);
      if (hasParent.exitCode === 0) {
        logArgs.push("HEAD~1..HEAD");
      } else {
        logArgs.push("--max-count=1", "HEAD");
      }
    } else {
      logArgs.push("--max-count=30", "HEAD");
    }

    logArgs.push("--", file.filePath);

    const history = await runGitCommand(logArgs, cwd);
    const historyLines = history.exitCode === 0
      ? history.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
      : [];

    const cells = [] as FileRevisionStripResponse["cells"];

    for (const line of historyLines) {
      const [commitId, epochRaw] = line.split("\t");
      if (!commitId) continue;

      const content = await readContentAtRevision(commitId, file);
      if (content === undefined) continue;

      const epoch = Number.parseInt(epochRaw || "", 10);
      const createdAt = Number.isFinite(epoch)
        ? new Date(epoch * 1000).toISOString()
        : new Date().toISOString();

      cells.push({
        revisionId: commitId,
        patchHash: hashRevisionContent(content),
        createdAt,
        order: cells.length,
        label: commitId.slice(0, 8),
        kind: "commit",
      });
    }

    if (effectiveDiffType === "uncommitted" || effectiveDiffType === "staged" || effectiveDiffType === "unstaged") {
      const workingRevisionId = `${WORKING_REVISION_PREFIX}${currentDiffType}`;
      const currentContent =
        context.currentNewContentByKey.get(getDiffFileKey(file.filePath, file.oldPath)) ?? null;

      cells.push({
        revisionId: workingRevisionId,
        patchHash: hashRevisionContent(currentContent),
        createdAt: new Date().toISOString(),
        order: cells.length,
        label: getWorkingRevisionLabel(effectiveDiffType),
        kind: "working-tree",
      });
    }

    const checkpoint = getCheckpointForFile(
      projectName,
      reviewerId,
      context.snapshot,
      file.filePath,
      file.oldPath,
    );

    const headRevisionId = cells[cells.length - 1]?.revisionId || context.snapshot.snapshotId;

    let reviewedRevisionId: string | undefined;
    if (checkpoint?.status === "reviewed") {
      if (cells.some((cell) => cell.revisionId === checkpoint.snapshotId)) {
        reviewedRevisionId = checkpoint.snapshotId;
      } else if (checkpoint.patchHash === file.patchHash) {
        reviewedRevisionId = headRevisionId;
      }
    }

    return {
      snapshot: context.snapshot,
      filePath: file.filePath,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      headRevisionId,
      ...(reviewedRevisionId ? { reviewedRevisionId } : {}),
      ...(reviewedRevisionId ? { defaultFloorRevisionId: reviewedRevisionId } : {}),
      defaultCeilingRevisionId: headRevisionId,
      cells,
    };
  };

  // Decision promise
  let resolveDecision: (result: {
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
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

          // API: Read file-local revision strip history
          if (url.pathname === "/api/review/file-history" && req.method === "GET") {
            const reviewerId = url.searchParams.get("reviewerId")?.trim();
            const filePath = url.searchParams.get("filePath")?.trim();
            const oldPath = url.searchParams.get("oldPath")?.trim() || undefined;

            if (!reviewerId || !filePath) {
              return Response.json({ error: "Missing reviewerId or filePath" }, { status: 400 });
            }

            try {
              const context = await getCurrentReviewContext();
              const currentFile = findCurrentFile(context.files, filePath, oldPath);
              if (!currentFile) {
                return Response.json({ error: "File not found in current diff" }, { status: 404 });
              }

              const strip = await buildCommitRevisionStrip(reviewerId, currentFile);

              return Response.json(strip);
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to read file history";
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
                throughRevisionId?: string;
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

              let checkpointRevisionId: string | undefined;
              let checkpointPatchHash: string | undefined;
              let checkpointBaselineNewContent: string | null | undefined;

              if (action === "mark-reviewed" && body.throughRevisionId) {
                const strip = await buildCommitRevisionStrip(reviewerId, currentFile);
                const selected = strip.cells.find((cell) => cell.revisionId === body.throughRevisionId);

                if (!selected) {
                  return Response.json({ error: "throughRevisionId not found for file" }, { status: 400 });
                }

                const selectedContent = await readContentAtRevision(selected.revisionId, currentFile);
                if (selectedContent === undefined) {
                  return Response.json({ error: "throughRevisionId could not be resolved" }, { status: 400 });
                }

                checkpointRevisionId = selected.revisionId;
                checkpointBaselineNewContent = selectedContent;
                checkpointPatchHash =
                  selected.revisionId === strip.headRevisionId
                    ? currentFile.patchHash
                    : selected.patchHash;
              }

              const fileState = applyCheckpointAction({
                project: projectName,
                reviewerId,
                filePath: currentFile.filePath,
                oldPath: currentFile.oldPath,
                action,
                snapshot: context.snapshot,
                currentFile,
                baselineNewContent,
                checkpointSnapshotId: checkpointRevisionId,
                checkpointPatchHash,
                checkpointBaselineNewContent,
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
                floorRevisionId?: string;
                ceilingRevisionId?: string;
                viewMode?: FileViewMode;
              };

              const reviewerId = body.reviewerId?.trim();
              const filePath = body.filePath?.trim();
              const viewMode = body.viewMode;
              const floorRevisionId = body.floorRevisionId?.trim();
              const ceilingRevisionId = body.ceilingRevisionId?.trim();

              if (!reviewerId || !filePath) {
                return Response.json({ error: "Missing reviewerId or filePath" }, { status: 400 });
              }

              if (viewMode && viewMode !== "full" && viewMode !== "delta") {
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

              const strip = await buildCommitRevisionStrip(reviewerId, currentFile);

              const headRevisionId = strip.headRevisionId;
              let effectiveCeilingRevisionId = ceilingRevisionId || headRevisionId;

              let effectiveFloorRevisionId = floorRevisionId;

              if (!effectiveFloorRevisionId && !ceilingRevisionId) {
                const checkpoint = getCheckpointForFile(
                  projectName,
                  reviewerId,
                  context.snapshot,
                  currentFile.filePath,
                  currentFile.oldPath,
                );

                if (
                  checkpoint?.status === "reviewed" &&
                  strip.cells.some((cell) => cell.revisionId === checkpoint.snapshotId)
                ) {
                  effectiveFloorRevisionId = checkpoint.snapshotId;
                }
              }

              const orderMap = new Map(strip.cells.map((cell, index) => [cell.revisionId, index]));

              if (ceilingRevisionId && !orderMap.has(effectiveCeilingRevisionId)) {
                return Response.json({ error: "ceilingRevisionId not found for file" }, { status: 400 });
              }

              if (effectiveFloorRevisionId && !orderMap.has(effectiveFloorRevisionId)) {
                return Response.json({ error: "floorRevisionId not found for file" }, { status: 400 });
              }

              const ceilingOrder = orderMap.get(effectiveCeilingRevisionId) ?? strip.cells.length - 1;
              const floorOrder = effectiveFloorRevisionId ? (orderMap.get(effectiveFloorRevisionId) ?? -1) : -1;

              if (effectiveFloorRevisionId && floorOrder > ceilingOrder) {
                return Response.json({ error: "floorRevisionId cannot be newer than ceilingRevisionId" }, { status: 400 });
              }

              if (!effectiveFloorRevisionId && effectiveCeilingRevisionId === headRevisionId && !ceilingRevisionId && !floorRevisionId) {
                return Response.json({
                  filePath: currentFile.filePath,
                  oldPath: currentFile.oldPath,
                  viewMode: "full" as const,
                  patch: currentFile.patch,
                  snapshotId: context.snapshot.snapshotId,
                });
              }

              const currentContents = await getFileContentsForDiff(
                currentDiffType,
                gitContext?.defaultBranch || "main",
                currentFile.filePath,
                currentFile.oldPath,
              );

              const ceilingContent = await readContentAtRevision(effectiveCeilingRevisionId, currentFile);
              if (ceilingContent === undefined) {
                return Response.json({
                  filePath: currentFile.filePath,
                  oldPath: currentFile.oldPath,
                  viewMode: "full" as const,
                  patch: currentFile.patch,
                  snapshotId: context.snapshot.snapshotId,
                });
              }

              let floorContent = currentContents.oldContent;
              if (effectiveFloorRevisionId) {
                const resolvedFloorContent = await readContentAtRevision(effectiveFloorRevisionId, currentFile);
                if (resolvedFloorContent === undefined) {
                  return Response.json({ error: "floorRevisionId not found for file" }, { status: 400 });
                }
                floorContent = resolvedFloorContent;
              }

              if (floorContent === ceilingContent) {
                return Response.json({
                  filePath: currentFile.filePath,
                  oldPath: currentFile.oldPath,
                  viewMode: "delta" as const,
                  patch: buildNoChangesPatch(currentFile.filePath, ceilingContent),
                  snapshotId: context.snapshot.snapshotId,
                  floorRevisionId: effectiveFloorRevisionId,
                  ceilingRevisionId: effectiveCeilingRevisionId,
                });
              }

              const deltaPatch = buildDeltaPatch({
                filePath: currentFile.filePath,
                baselineNewContent: floorContent,
                currentNewContent: ceilingContent,
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
                floorRevisionId: effectiveFloorRevisionId,
                ceilingRevisionId: effectiveCeilingRevisionId,
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
                approved?: boolean;
                feedback: string;
                annotations: unknown[];
                agentSwitch?: string;
              };

              deleteDraft(draftKey);
              resolveDecision({
                approved: body.approved ?? false,
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

          // Favicon
          if (url.pathname === "/favicon.svg") return handleFavicon();

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
