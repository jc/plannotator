/**
 * Runtime-agnostic PR provider shared by Bun runtimes and Pi.
 *
 * Same pattern as review-core.ts: a runtime interface abstracts subprocess
 * execution so the logic is reusable across Bun and Node/jiti.
 */

// --- Types ---

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PRRuntime {
  runCommand: (
    cmd: string,
    args: string[],
  ) => Promise<CommandResult>;
}

export interface PRRef {
  platform: "github";
  owner: string;
  repo: string;
  number: number;
}

export interface PRMetadata {
  platform: "github";
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  url: string;
}

// --- URL Parsing ---

/**
 * Parse a PR URL into its components.
 *
 * Handles:
 * - https://github.com/owner/repo/pull/123
 * - https://github.com/owner/repo/pull/123/files
 * - https://github.com/owner/repo/pull/123/commits
 */
export function parsePRUrl(url: string): PRRef | null {
  if (!url) return null;

  // GitHub: https://github.com/{owner}/{repo}/pull/{number}[/...]
  const ghMatch = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (ghMatch) {
    return {
      platform: "github",
      owner: ghMatch[1],
      repo: ghMatch[2],
      number: parseInt(ghMatch[3], 10),
    };
  }

  return null;
}

// --- Auth ---

export async function checkGhAuth(runtime: PRRuntime): Promise<void> {
  const result = await runtime.runCommand("gh", ["auth", "status"]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `GitHub CLI not authenticated. Run \`gh auth login\` first.\n${stderr}`,
    );
  }
}

// --- Fetch PR ---

export async function fetchPR(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  const repo = `${ref.owner}/${ref.repo}`;

  // Fetch diff and metadata in parallel
  const [diffResult, viewResult] = await Promise.all([
    runtime.runCommand("gh", [
      "pr", "diff", String(ref.number),
      "--repo", repo,
    ]),
    runtime.runCommand("gh", [
      "pr", "view", String(ref.number),
      "--repo", repo,
      "--json", "title,author,baseRefName,headRefName,baseRefOid,headRefOid,url",
    ]),
  ]);

  if (diffResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR diff: ${diffResult.stderr.trim() || `exit code ${diffResult.exitCode}`}`,
    );
  }

  if (viewResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR metadata: ${viewResult.stderr.trim() || `exit code ${viewResult.exitCode}`}`,
    );
  }

  const raw = JSON.parse(viewResult.stdout) as {
    title: string;
    author: { login: string };
    baseRefName: string;
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
    url: string;
  };

  const metadata: PRMetadata = {
    platform: "github",
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: raw.title,
    author: raw.author.login,
    baseBranch: raw.baseRefName,
    headBranch: raw.headRefName,
    baseSha: raw.baseRefOid,
    headSha: raw.headRefOid,
    url: raw.url,
  };

  return { metadata, rawPatch: diffResult.stdout };
}

// --- File Content ---

export async function fetchPRFileContent(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  const result = await runtime.runCommand("gh", [
    "api",
    `repos/${ref.owner}/${ref.repo}/contents/${filePath}?ref=${sha}`,
    "--jq", ".content",
  ]);

  if (result.exitCode !== 0) return null;

  const base64Content = result.stdout.trim();
  if (!base64Content) return null;

  // GitHub returns base64-encoded content with newlines
  const cleaned = base64Content.replace(/\n/g, "");
  try {
    return Buffer.from(cleaned, "base64").toString("utf-8");
  } catch {
    return null;
  }
}
