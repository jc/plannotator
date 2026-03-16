/**
 * Node-compatible servers for Plannotator Pi extension.
 *
 * Pi loads extensions via jiti (Node.js), so we can't use Bun.serve().
 * These are lightweight node:http servers implementing just the routes
 * each UI needs — plan review, code review, and markdown annotation.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { execSync, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, basename, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import {
  type DiffOption,
  type DiffType,
  type GitCommandResult,
  type GitContext,
  type ReviewGitRuntime,
  getFileContentsForDiff as getFileContentsForDiffCore,
  getGitContext as getGitContextCore,
  gitAddFile as gitAddFileCore,
  gitResetFile as gitResetFileCore,
  parseWorktreeDiffType,
  runGitDiff as runGitDiffCore,
  validateFilePath,
} from "./review-core.js";
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
  type FileCheckpointAction,
  type FileRevisionStripResponse,
  type FileViewMode,
  type ReviewSnapshotMeta,
} from "./review-state-core.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: import("node:http").ServerResponse, content: string): void {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(content);
}

function send(
  res: import("node:http").ServerResponse,
  body: string | Buffer,
  status = 200,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, headers);
  res.end(body);
}

interface EditorAnnotation {
  id: string;
  filePath: string;
  selectedText: string;
  lineStart: number;
  lineEnd: number;
  comment?: string;
  createdAt: number;
}

function createEditorAnnotationHandler() {
  const annotations: EditorAnnotation[] = [];

  return {
    async handle(req: IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname === "/api/editor-annotations" && req.method === "GET") {
        json(res, { annotations });
        return true;
      }

      if (url.pathname === "/api/editor-annotation" && req.method === "POST") {
        const body = await parseBody(req);
        if (!body.filePath || !body.selectedText || !body.lineStart || !body.lineEnd) {
          json(res, { error: "Missing required fields" }, 400);
          return true;
        }

        const annotation: EditorAnnotation = {
          id: randomUUID(),
          filePath: String(body.filePath),
          selectedText: String(body.selectedText),
          lineStart: Number(body.lineStart),
          lineEnd: Number(body.lineEnd),
          comment: typeof body.comment === "string" ? body.comment : undefined,
          createdAt: Date.now(),
        };

        annotations.push(annotation);
        json(res, { id: annotation.id });
        return true;
      }

      if (url.pathname === "/api/editor-annotation" && req.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) {
          json(res, { error: "Missing id parameter" }, 400);
          return true;
        }
        const idx = annotations.findIndex((annotation) => annotation.id === id);
        if (idx !== -1) {
          annotations.splice(idx, 1);
        }
        json(res, { ok: true });
        return true;
      }

      return false;
    },
  };
}

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "tiff",
  "tif",
  "avif",
]);

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",
};

const UPLOAD_DIR = join(os.tmpdir(), "plannotator");

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filePath.slice(lastDot + 1).toLowerCase();
}

function validateImagePath(rawPath: string): {
  valid: boolean;
  resolved: string;
  error?: string;
} {
  const resolved = resolvePath(rawPath);
  const ext = getExtension(resolved);

  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      resolved,
      error: "Path does not point to a supported image file",
    };
  }

  return { valid: true, resolved };
}

function validateUploadExtension(fileName: string): {
  valid: boolean;
  ext: string;
  error?: string;
} {
  const ext = getExtension(fileName) || "png";
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      ext,
      error: `File extension ".${ext}" is not a supported image type`,
    };
  }

  return { valid: true, ext };
}

function getImageContentType(filePath: string): string {
  return IMAGE_CONTENT_TYPES[getExtension(filePath)] || "application/octet-stream";
}

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as BodyInit;
    init.duplex = "half";
  }

  return new Request(`http://localhost${req.url ?? "/"}`, init);
}

const DEFAULT_REMOTE_PORT = 19432;

/**
 * Check if running in a remote session (SSH, devcontainer, etc.)
 * Honors PLANNOTATOR_REMOTE env var, or detects SSH_TTY/SSH_CONNECTION.
 */
function isRemoteSession(): boolean {
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === "1" || remote?.toLowerCase() === "true") {
    return true;
  }
  // Legacy SSH detection
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  return false;
}

/**
 * Get the server port to use.
 * - PLANNOTATOR_PORT env var takes precedence
 * - Remote sessions default to 19432 (for port forwarding)
 * - Local sessions use random port
 * Returns { port, portSource } so caller can notify user if needed.
 */
function getServerPort(): { port: number; portSource: "env" | "remote-default" | "random" } {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return { port: parsed, portSource: "env" };
    }
    // Invalid port - fall back silently, caller can check env var themselves
  }
  if (isRemoteSession()) {
    return { port: DEFAULT_REMOTE_PORT, portSource: "remote-default" };
  }
  return { port: 0, portSource: "random" };
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

async function listenOnPort(server: Server): Promise<{ port: number; portSource: "env" | "remote-default" | "random" }> {
  const result = getServerPort();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(result.port, isRemoteSession() ? "0.0.0.0" : "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const addr = server.address() as { port: number };
      return { port: addr.port, portSource: result.portSource };
    } catch (err: unknown) {
      const isAddressInUse = err instanceof Error && err.message.includes("EADDRINUSE");
      if (isAddressInUse && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      if (isAddressInUse) {
        const hint = isRemoteSession() ? " (set PLANNOTATOR_PORT to use a different port)" : "";
        throw new Error(`Port ${result.port} in use after ${MAX_RETRIES} retries${hint}`);
      }
      throw err;
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("Failed to bind port");
}

/**
 * Open URL in system browser (Node-compatible, no Bun $ dependency).
 * Honors PLANNOTATOR_BROWSER and BROWSER env vars, matching packages/server/browser.ts.
 * Returns { opened: true } if browser was opened, { opened: false, isRemote: true, url } if remote session.
 */
export function openBrowser(url: string): { opened: boolean; isRemote?: boolean; url?: string } {
  const browser = process.env.PLANNOTATOR_BROWSER || process.env.BROWSER;
  if (isRemoteSession() && !browser) {
    return { opened: false, isRemote: true, url };
  }

  try {
    const platform = process.platform;
    const wsl = platform === "linux" && os.release().toLowerCase().includes("microsoft");

    let cmd: string;
    let args: string[];

    if (browser) {
      if (process.env.PLANNOTATOR_BROWSER && platform === "darwin") {
        cmd = "open";
        args = ["-a", browser, url];
      } else if (platform === "win32" || wsl) {
        cmd = "cmd.exe";
        args = ["/c", "start", "", browser, url];
      } else {
        cmd = browser;
        args = [url];
      }
    } else if (platform === "win32" || wsl) {
      cmd = "cmd.exe";
      args = ["/c", "start", "", url];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }

    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", () => {});
    child.unref();
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

// ── Version History (Node-compatible, duplicated from packages/server) ──

function sanitizeTag(name: string): string | null {
  if (!name || typeof name !== "string") return null;
  const sanitized = name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return sanitized.length >= 2 ? sanitized : null;
}

function extractFirstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1].trim();
}

function generateSlug(plan: string): string {
  const date = new Date().toISOString().split("T")[0];
  const heading = extractFirstHeading(plan);
  const slug = heading ? sanitizeTag(heading) : null;
  return slug ? `${slug}-${date}` : `plan-${date}`;
}

function detectProjectName(): string {
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const name = basename(toplevel);
    return sanitizeTag(name) ?? "_unknown";
  } catch {
    // Not a git repo — fall back to cwd
  }
  try {
    const name = basename(process.cwd());
    return sanitizeTag(name) ?? "_unknown";
  } catch {
    return "_unknown";
  }
}

function parseRemoteUrl(url: string): string | null {
  if (!url) return null;

  const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = url.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

function getDirName(path: string): string | null {
  if (!path) return null;
  const trimmed = path.trim().replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || null;
}

function getRepoInfo(): { display: string; branch?: string } | null {
  const branch = git("rev-parse --abbrev-ref HEAD");
  const safeBranch = branch && branch !== "HEAD" ? branch : undefined;

  const originUrl = git("remote get-url origin");
  const orgRepo = parseRemoteUrl(originUrl);
  if (orgRepo) {
    return { display: orgRepo, branch: safeBranch };
  }

  const topLevel = git("rev-parse --show-toplevel");
  const repoName = getDirName(topLevel);
  if (repoName) {
    return { display: repoName, branch: safeBranch };
  }

  const cwdName = getDirName(process.cwd());
  if (cwdName) {
    return { display: cwdName };
  }

  return null;
}

function getHistoryDir(project: string, slug: string): string {
  const historyDir = join(os.homedir(), ".plannotator", "history", project, slug);
  mkdirSync(historyDir, { recursive: true });
  return historyDir;
}

function getNextVersionNumber(historyDir: string): number {
  try {
    const entries = readdirSync(historyDir);
    let max = 0;
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.md$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

function saveToHistory(
  project: string,
  slug: string,
  plan: string,
): { version: number; path: string; isNew: boolean } {
  const historyDir = getHistoryDir(project, slug);
  const nextVersion = getNextVersionNumber(historyDir);
  if (nextVersion > 1) {
    const latestPath = join(historyDir, `${String(nextVersion - 1).padStart(3, "0")}.md`);
    try {
      const existing = readFileSync(latestPath, "utf-8");
      if (existing === plan) {
        return { version: nextVersion - 1, path: latestPath, isNew: false };
      }
    } catch { /* proceed with saving */ }
  }
  const fileName = `${String(nextVersion).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);
  writeFileSync(filePath, plan, "utf-8");
  return { version: nextVersion, path: filePath, isNew: true };
}

function getPlanVersion(
  project: string,
  slug: string,
  version: number,
): string | null {
  const historyDir = join(os.homedir(), ".plannotator", "history", project, slug);
  const fileName = `${String(version).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function getVersionCount(project: string, slug: string): number {
  const historyDir = join(os.homedir(), ".plannotator", "history", project, slug);
  try {
    const entries = readdirSync(historyDir);
    return entries.filter((e) => /^\d+\.md$/.test(e)).length;
  } catch {
    return 0;
  }
}

function listVersions(
  project: string,
  slug: string,
): Array<{ version: number; timestamp: string }> {
  const historyDir = join(os.homedir(), ".plannotator", "history", project, slug);
  try {
    const entries = readdirSync(historyDir);
    const versions: Array<{ version: number; timestamp: string }> = [];
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.md$/);
      if (match) {
        const version = parseInt(match[1], 10);
        const filePath = join(historyDir, entry);
        try {
          const stat = statSync(filePath);
          versions.push({ version, timestamp: stat.mtime.toISOString() });
        } catch {
          versions.push({ version, timestamp: "" });
        }
      }
    }
    return versions.sort((a, b) => a.version - b.version);
  } catch {
    return [];
  }
}

function listProjectPlans(
  project: string,
): Array<{ slug: string; versions: number; lastModified: string }> {
  const projectDir = join(os.homedir(), ".plannotator", "history", project);
  try {
    const entries = readdirSync(projectDir, { withFileTypes: true });
    const plans: Array<{ slug: string; versions: number; lastModified: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slugDir = join(projectDir, entry.name);
      const files = readdirSync(slugDir).filter((f) => /^\d+\.md$/.test(f));
      if (files.length === 0) continue;
      let latest = 0;
      for (const file of files) {
        try {
          const mtime = statSync(join(slugDir, file)).mtime.getTime();
          if (mtime > latest) latest = mtime;
        } catch { /* skip */ }
      }
      plans.push({
        slug: entry.name,
        versions: files.length,
        lastModified: latest ? new Date(latest).toISOString() : "",
      });
    }
    return plans.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  } catch {
    return [];
  }
}

function getDraftDir(): string {
  const dir = join(os.homedir(), ".plannotator", "drafts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function saveDraft(key: string, data: object): void {
  writeFileSync(join(getDraftDir(), `${key}.json`), JSON.stringify(data), "utf-8");
}

function loadDraft(key: string): object | null {
  const filePath = join(getDraftDir(), `${key}.json`);
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function deleteDraft(key: string): void {
  const filePath = join(getDraftDir(), `${key}.json`);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Ignore delete failures
  }
}

// ── Plan Review Server ──────────────────────────────────────────────────

export interface PlanServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<{ approved: boolean; feedback?: string }>;
  stop: () => void;
}

export async function startPlanReviewServer(options: {
  plan: string;
  htmlContent: string;
  origin?: string;
}): Promise<PlanServerResult> {
  // Version history
  const slug = generateSlug(options.plan);
  const project = detectProjectName();
  const historyResult = saveToHistory(project, slug, options.plan);
  const previousPlan =
    historyResult.version > 1
      ? getPlanVersion(project, slug, historyResult.version - 1)
      : null;
  const versionInfo = {
    version: historyResult.version,
    totalVersions: getVersionCount(project, slug),
    project,
  };

  let resolveDecision!: (result: { approved: boolean; feedback?: string }) => void;
  const decisionPromise = new Promise<{ approved: boolean; feedback?: string }>((r) => {
    resolveDecision = r;
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    if (url.pathname === "/api/plan/version") {
      const vParam = url.searchParams.get("v");
      if (!vParam) {
        json(res, { error: "Missing v parameter" }, 400);
        return;
      }
      const v = parseInt(vParam, 10);
      if (isNaN(v) || v < 1) {
        json(res, { error: "Invalid version number" }, 400);
        return;
      }
      const content = getPlanVersion(project, slug, v);
      if (content === null) {
        json(res, { error: "Version not found" }, 404);
        return;
      }
      json(res, { plan: content, version: v });
    } else if (url.pathname === "/api/plan/versions") {
      json(res, { project, slug, versions: listVersions(project, slug) });
    } else if (url.pathname === "/api/plan/history") {
      json(res, { project, plans: listProjectPlans(project) });
    } else if (url.pathname === "/api/plan") {
      json(res, { plan: options.plan, origin: options.origin ?? "pi", previousPlan, versionInfo });
    } else if (url.pathname === "/api/approve" && req.method === "POST") {
      const body = await parseBody(req);
      resolveDecision({ approved: true, feedback: body.feedback as string | undefined });
      json(res, { ok: true });
    } else if (url.pathname === "/api/deny" && req.method === "POST") {
      const body = await parseBody(req);
      resolveDecision({ approved: false, feedback: (body.feedback as string) || "Plan rejected" });
      json(res, { ok: true });
    } else {
      html(res, options.htmlContent);
    }
  });

  const { port, portSource } = await listenOnPort(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}

export type { DiffType, DiffOption, GitContext } from "./review-core.js";

export interface ReviewServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }>;
  stop: () => void;
}

/** Run a git command and return stdout (empty string on error). */
function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

const reviewRuntime: ReviewGitRuntime = {
  async runGit(args: string[], options?: { cwd?: string }): Promise<GitCommandResult> {
    const result = spawnSync("git", args, {
      cwd: options?.cwd,
      encoding: "utf-8",
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? (result.error ? 1 : 0),
    };
  },

  async readTextFile(path: string): Promise<string | null> {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  },
};

export function getGitContext(): Promise<GitContext> {
  return getGitContextCore(reviewRuntime);
}

export function runGitDiff(
  diffType: DiffType,
  defaultBranch = "main",
): Promise<{ patch: string; label: string; error?: string }> {
  return runGitDiffCore(reviewRuntime, diffType, defaultBranch);
}

export async function startReviewServer(options: {
  rawPatch: string;
  gitRef: string;
  htmlContent: string;
  origin?: string;
  diffType?: DiffType;
  gitContext?: GitContext;
  error?: string;
  sharingEnabled?: boolean;
  shareBaseUrl?: string;
}): Promise<ReviewServerResult> {
  const draftKey = contentHash(options.rawPatch);
  const repoInfo = getRepoInfo();
  const editorAnnotations = createEditorAnnotationHandler();
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";
  let currentError = options.error;
  const sharingEnabled =
    options.sharingEnabled ?? process.env.PLANNOTATOR_SHARE !== "disabled";
  const shareBaseUrl =
    (options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL) || undefined;

  const projectName = detectProjectName();

  let reviewContext:
    | {
        snapshot: ReviewSnapshotMeta;
        files: CurrentDiffFile[];
        currentNewContentByKey: Map<string, string | null>;
      }
    | null = null;

  const invalidateReviewContext = () => {
    reviewContext = null;
  };

  const getCurrentReviewContext = async () => {
    if (reviewContext) return reviewContext;

    const files = parseDiffToCurrentFiles(currentPatch);
    const snapshot = buildSnapshotMeta({
      rawPatch: currentPatch,
      diffType: currentDiffType,
      gitRef: currentGitRef,
    });
    const defaultBranch = options.gitContext?.defaultBranch || "main";

    const fileContentPairs = await Promise.all(
      files.map(async (file) => {
        const contents = await getFileContentsForDiffCore(
          reviewRuntime,
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

    reviewContext = { snapshot, files, currentNewContentByKey };
    return reviewContext;
  };

  type EffectiveDiffType = "uncommitted" | "staged" | "unstaged" | "last-commit" | "branch";
  const WORKING_REVISION_PREFIX = "wt:";

  const hashRevisionContent = (content: string | null): string => {
    const payload = content === null ? "__NULL__" : content;
    return `h_${createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
  };

  const findCurrentFile = (files: CurrentDiffFile[], filePath: string, oldPath?: string): CurrentDiffFile | undefined => {
    if (oldPath) {
      return files.find((file) => file.filePath === filePath && file.oldPath === oldPath);
    }
    return files.find((file) => file.filePath === filePath);
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
    const result = await reviewRuntime.runGit(args, { cwd });
    return { stdout: result.stdout, exitCode: result.exitCode };
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
    const defaultBranch = options.gitContext?.defaultBranch || "main";

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

  let resolveDecision!: (result: {
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
  }>((r) => {
    resolveDecision = r;
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    if (url.pathname === "/api/diff" && req.method === "GET") {
      json(res, {
        rawPatch: currentPatch,
        gitRef: currentGitRef,
        origin: options.origin ?? "pi",
        diffType: currentDiffType,
        gitContext: options.gitContext,
        sharingEnabled,
        shareBaseUrl,
        repoInfo,
        ...(currentError ? { error: currentError } : {}),
      });
    } else if (url.pathname === "/api/diff/switch" && req.method === "POST") {
      const body = await parseBody(req);
      const newType = body.diffType as DiffType;
      if (!newType) {
        json(res, { error: "Missing diffType" }, 400);
        return;
      }
      const defaultBranch = options.gitContext?.defaultBranch || "main";
      const result = await runGitDiff(newType, defaultBranch);
      currentPatch = result.patch;
      currentGitRef = result.label;
      currentDiffType = newType;
      invalidateReviewContext();
      currentError = result.error;
      json(res, {
        rawPatch: currentPatch,
        gitRef: currentGitRef,
        diffType: currentDiffType,
        ...(currentError ? { error: currentError } : {}),
      });
    } else if (url.pathname === "/api/file-content" && req.method === "GET") {
      const filePath = url.searchParams.get("path");
      const oldPath = url.searchParams.get("oldPath") || undefined;
      if (!filePath) {
        json(res, { error: "Missing path" }, 400);
        return;
      }
      try {
        validateFilePath(filePath);
        if (oldPath) validateFilePath(oldPath);
      } catch {
        json(res, { error: "Invalid path" }, 400);
        return;
      }
      const defaultBranch = options.gitContext?.defaultBranch || "main";
      const result = await getFileContentsForDiffCore(
        reviewRuntime,
        currentDiffType,
        defaultBranch,
        filePath,
        oldPath,
      );
      json(res, result);
    } else if (url.pathname === "/api/image") {
      const imagePath = url.searchParams.get("path");
      if (!imagePath) {
        send(res, "Missing path parameter", 400, { "Content-Type": "text/plain" });
        return;
      }

      const tryServePath = (candidate: string): boolean => {
        const validation = validateImagePath(candidate);
        if (!validation.valid) {
          return false;
        }
        try {
          if (!existsSync(validation.resolved)) {
            return false;
          }
          const data = readFileSync(validation.resolved);
          send(res, data, 200, { "Content-Type": getImageContentType(validation.resolved) });
          return true;
        } catch {
          return false;
        }
      };

      if (tryServePath(imagePath)) return;

      const base = url.searchParams.get("base");
      if (base && !imagePath.startsWith("/") && tryServePath(resolvePath(base, imagePath))) {
        return;
      }

      const validation = validateImagePath(imagePath);
      if (!validation.valid) {
        send(res, validation.error || "Invalid image path", 403, { "Content-Type": "text/plain" });
        return;
      }

      send(res, "File not found", 404, { "Content-Type": "text/plain" });
    } else if (url.pathname === "/api/upload" && req.method === "POST") {
      try {
        const request = toWebRequest(req);
        const formData = await request.formData();
        const file = formData.get("file");
        if (!file || typeof file !== "object" || !("arrayBuffer" in file) || !("name" in file)) {
          json(res, { error: "No file provided" }, 400);
          return;
        }

        const upload = file as File;
        const extResult = validateUploadExtension(upload.name);
        if (!extResult.valid) {
          json(res, { error: extResult.error }, 400);
          return;
        }

        mkdirSync(UPLOAD_DIR, { recursive: true });
        const tempPath = join(UPLOAD_DIR, `${randomUUID()}.${extResult.ext}`);
        const bytes = Buffer.from(await upload.arrayBuffer());
        writeFileSync(tempPath, bytes);
        json(res, { path: tempPath, originalName: upload.name });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        json(res, { error: message }, 500);
      }
    } else if (url.pathname === "/api/agents" && req.method === "GET") {
      json(res, { agents: [] });
    } else if (url.pathname === "/api/git-add" && req.method === "POST") {
      const body = await parseBody(req);
      const filePath = body.filePath as string | undefined;
      const undo = !!body.undo;
      if (!filePath) {
        json(res, { error: "Missing filePath" }, 400);
        return;
      }
      try {
        let cwd: string | undefined;
        if (currentDiffType.startsWith("worktree:")) {
          const parsed = parseWorktreeDiffType(currentDiffType);
          if (parsed) cwd = parsed.path;
        }
        if (undo) {
          await gitResetFileCore(reviewRuntime, filePath, cwd);
        } else {
          await gitAddFileCore(reviewRuntime, filePath, cwd);
        }
        invalidateReviewContext();
        json(res, { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to git add";
        json(res, { error: message }, 500);
      }
    } else if (url.pathname === "/api/review/state" && req.method === "GET") {
      const reviewerId = url.searchParams.get("reviewerId")?.trim();
      if (!reviewerId) {
        json(res, { error: "Missing reviewerId" }, 400);
        return;
      }

      const context = await getCurrentReviewContext();
      const state = getReviewState(
        projectName,
        reviewerId,
        context.snapshot,
        context.files,
      );

      json(res, state);
    } else if (url.pathname === "/api/review/file-history" && req.method === "GET") {
      const reviewerId = url.searchParams.get("reviewerId")?.trim();
      const filePath = url.searchParams.get("filePath")?.trim();
      const oldPath = url.searchParams.get("oldPath")?.trim() || undefined;

      if (!reviewerId || !filePath) {
        json(res, { error: "Missing reviewerId or filePath" }, 400);
        return;
      }

      const context = await getCurrentReviewContext();
      const file = findCurrentFile(context.files, filePath, oldPath);

      if (!file) {
        json(res, { error: "File not found in current diff" }, 404);
        return;
      }

      const strip = await buildCommitRevisionStrip(reviewerId, file);
      json(res, strip);
    } else if (url.pathname === "/api/review/checkpoint" && req.method === "POST") {
      const body = await parseBody(req);
      const reviewerId = (body.reviewerId as string | undefined)?.trim();
      const filePath = (body.filePath as string | undefined)?.trim();
      const oldPath = (body.oldPath as string | undefined)?.trim();
      const throughRevisionId = (body.throughRevisionId as string | undefined)?.trim();
      const action = body.action as FileCheckpointAction | undefined;

      if (!reviewerId || !filePath || !action) {
        json(res, { error: "Missing reviewerId, filePath, or action" }, 400);
        return;
      }

      if (!(["mark-reviewed", "skip", "reset"] as FileCheckpointAction[]).includes(action)) {
        json(res, { error: "Invalid action" }, 400);
        return;
      }

      const context = await getCurrentReviewContext();
      const file = findCurrentFile(context.files, filePath, oldPath);

      if (!file) {
        json(res, { error: "File not found in current diff" }, 404);
        return;
      }

      const fileKey = getDiffFileKey(file.filePath, file.oldPath);
      const baselineNewContent =
        context.currentNewContentByKey.get(fileKey) ?? null;

      let checkpointRevisionId: string | undefined;
      let checkpointPatchHash: string | undefined;
      let checkpointBaselineNewContent: string | null | undefined;

      if (action === "mark-reviewed" && throughRevisionId) {
        const strip = await buildCommitRevisionStrip(reviewerId, file);
        const selected = strip.cells.find((cell) => cell.revisionId === throughRevisionId);

        if (!selected) {
          json(res, { error: "throughRevisionId not found for file" }, 400);
          return;
        }

        const selectedContent = await readContentAtRevision(selected.revisionId, file);
        if (selectedContent === undefined) {
          json(res, { error: "throughRevisionId could not be resolved" }, 400);
          return;
        }

        checkpointRevisionId = selected.revisionId;
        checkpointBaselineNewContent = selectedContent;
        checkpointPatchHash =
          selected.revisionId === strip.headRevisionId
            ? file.patchHash
            : selected.patchHash;
      }

      const fileState = applyCheckpointAction({
        project: projectName,
        reviewerId,
        filePath: file.filePath,
        oldPath: file.oldPath,
        action,
        snapshot: context.snapshot,
        currentFile: file,
        baselineNewContent,
        checkpointSnapshotId: checkpointRevisionId,
        checkpointPatchHash,
        checkpointBaselineNewContent,
      });

      json(res, {
        snapshot: context.snapshot,
        file: fileState,
      });
    } else if (url.pathname === "/api/review/file-view" && req.method === "POST") {
      const body = await parseBody(req);
      const reviewerId = (body.reviewerId as string | undefined)?.trim();
      const filePath = (body.filePath as string | undefined)?.trim();
      const oldPath = (body.oldPath as string | undefined)?.trim();
      const floorRevisionId = (body.floorRevisionId as string | undefined)?.trim();
      const ceilingRevisionId = (body.ceilingRevisionId as string | undefined)?.trim();
      const viewMode = body.viewMode as FileViewMode | undefined;

      if (!reviewerId || !filePath) {
        json(res, { error: "Missing reviewerId or filePath" }, 400);
        return;
      }

      if (viewMode && viewMode !== "full" && viewMode !== "delta") {
        json(res, { error: "Invalid viewMode" }, 400);
        return;
      }

      const context = await getCurrentReviewContext();
      const file = findCurrentFile(context.files, filePath, oldPath);

      if (!file) {
        json(res, { error: "File not found in current diff" }, 404);
        return;
      }

      if (viewMode === "full") {
        json(res, {
          filePath: file.filePath,
          oldPath: file.oldPath,
          viewMode: "full",
          patch: file.patch,
          snapshotId: context.snapshot.snapshotId,
        });
        return;
      }

      const strip = await buildCommitRevisionStrip(reviewerId, file);
      const headRevisionId = strip.headRevisionId;
      let effectiveCeilingRevisionId = ceilingRevisionId || headRevisionId;
      let effectiveFloorRevisionId = floorRevisionId;

      if (!effectiveFloorRevisionId && !ceilingRevisionId) {
        const checkpoint = getCheckpointForFile(
          projectName,
          reviewerId,
          context.snapshot,
          file.filePath,
          file.oldPath,
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
        json(res, { error: "ceilingRevisionId not found for file" }, 400);
        return;
      }

      if (effectiveFloorRevisionId && !orderMap.has(effectiveFloorRevisionId)) {
        json(res, { error: "floorRevisionId not found for file" }, 400);
        return;
      }

      const ceilingOrder = orderMap.get(effectiveCeilingRevisionId) ?? strip.cells.length - 1;
      const floorOrder = effectiveFloorRevisionId ? (orderMap.get(effectiveFloorRevisionId) ?? -1) : -1;

      if (effectiveFloorRevisionId && floorOrder > ceilingOrder) {
        json(res, { error: "floorRevisionId cannot be newer than ceilingRevisionId" }, 400);
        return;
      }

      if (!effectiveFloorRevisionId && effectiveCeilingRevisionId === headRevisionId && !ceilingRevisionId && !floorRevisionId) {
        json(res, {
          filePath: file.filePath,
          oldPath: file.oldPath,
          viewMode: "full",
          patch: file.patch,
          snapshotId: context.snapshot.snapshotId,
        });
        return;
      }

      const defaultBranch = options.gitContext?.defaultBranch || "main";
      const currentContents = await getFileContentsForDiffCore(
        reviewRuntime,
        currentDiffType,
        defaultBranch,
        file.filePath,
        file.oldPath,
      );

      const ceilingContent = await readContentAtRevision(effectiveCeilingRevisionId, file);
      if (ceilingContent === undefined) {
        json(res, {
          filePath: file.filePath,
          oldPath: file.oldPath,
          viewMode: "full",
          patch: file.patch,
          snapshotId: context.snapshot.snapshotId,
        });
        return;
      }

      let floorContent = currentContents.oldContent;
      if (effectiveFloorRevisionId) {
        const resolvedFloorContent = await readContentAtRevision(effectiveFloorRevisionId, file);
        if (resolvedFloorContent === undefined) {
          json(res, { error: "floorRevisionId not found for file" }, 400);
          return;
        }
        floorContent = resolvedFloorContent;
      }

      if (floorContent === ceilingContent) {
        json(res, {
          filePath: file.filePath,
          oldPath: file.oldPath,
          viewMode: "delta",
          patch: buildNoChangesPatch(file.filePath, ceilingContent),
          snapshotId: context.snapshot.snapshotId,
          floorRevisionId: effectiveFloorRevisionId,
          ceilingRevisionId: effectiveCeilingRevisionId,
        });
        return;
      }

      const deltaPatch = buildDeltaPatch({
        filePath: file.filePath,
        baselineNewContent: floorContent,
        currentNewContent: ceilingContent,
      });

      if (!deltaPatch || !deltaPatch.includes("@@")) {
        json(res, {
          filePath: file.filePath,
          oldPath: file.oldPath,
          viewMode: "full",
          patch: file.patch,
          snapshotId: context.snapshot.snapshotId,
        });
        return;
      }

      json(res, {
        filePath: file.filePath,
        oldPath: file.oldPath,
        viewMode: "delta",
        patch: deltaPatch,
        snapshotId: context.snapshot.snapshotId,
        floorRevisionId: effectiveFloorRevisionId,
        ceilingRevisionId: effectiveCeilingRevisionId,
      });
    } else if (url.pathname === "/api/draft") {
      if (req.method === "POST") {
        const body = await parseBody(req);
        saveDraft(draftKey, body);
        json(res, { ok: true });
      } else if (req.method === "DELETE") {
        deleteDraft(draftKey);
        json(res, { ok: true });
      } else {
        const draft = loadDraft(draftKey);
        if (!draft) {
          json(res, { found: false }, 404);
          return;
        }
        json(res, draft);
      }
    } else if (await editorAnnotations.handle(req, res, url)) {
      return;
    } else if (url.pathname === "/api/feedback" && req.method === "POST") {
      const body = await parseBody(req);
      deleteDraft(draftKey);
      resolveDecision({
        approved: (body.approved as boolean) ?? false,
        feedback: (body.feedback as string) || "",
        annotations: (body.annotations as unknown[]) || [],
        agentSwitch: body.agentSwitch as string | undefined,
      });
      json(res, { ok: true });
    } else {
      html(res, options.htmlContent);
    }
  });

  const { port, portSource } = await listenOnPort(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}

// ── Annotate Server ─────────────────────────────────────────────────────

export interface AnnotateServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<{ feedback: string }>;
  stop: () => void;
}

export async function startAnnotateServer(options: {
  markdown: string;
  filePath: string;
  htmlContent: string;
  origin?: string;
}): Promise<AnnotateServerResult> {
  let resolveDecision!: (result: { feedback: string }) => void;
  const decisionPromise = new Promise<{ feedback: string }>((r) => {
    resolveDecision = r;
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    if (url.pathname === "/api/plan" && req.method === "GET") {
      json(res, {
        plan: options.markdown,
        origin: options.origin ?? "pi",
        mode: "annotate",
        filePath: options.filePath,
      });
    } else if (url.pathname === "/api/feedback" && req.method === "POST") {
      const body = await parseBody(req);
      resolveDecision({ feedback: (body.feedback as string) || "" });
      json(res, { ok: true });
    } else {
      html(res, options.htmlContent);
    }
  });

  const { port, portSource } = await listenOnPort(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}
