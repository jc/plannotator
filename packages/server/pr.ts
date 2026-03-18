/**
 * PR provider for Bun runtimes
 *
 * Thin wrapper around shared pr-provider.ts, same pattern as git.ts.
 * Pre-binds a Bun-based runtime so consumers get a clean API.
 */

import {
  type PRRef,
  type PRMetadata,
  type PRRuntime,
  parsePRUrl as parsePRUrlCore,
  checkGhAuth as checkGhAuthCore,
  fetchPR as fetchPRCore,
  fetchPRFileContent as fetchPRFileContentCore,
} from "@plannotator/shared/pr-provider";

export type { PRRef, PRMetadata } from "@plannotator/shared/pr-provider";

const runtime: PRRuntime = {
  async runCommand(cmd, args) {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  },
};

export const parsePRUrl = parsePRUrlCore;

export function checkGhAuth(): Promise<void> {
  return checkGhAuthCore(runtime);
}

export function fetchPR(
  ref: PRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  return fetchPRCore(runtime, ref);
}

export function fetchPRFileContent(
  ref: PRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  return fetchPRFileContentCore(runtime, ref, sha, filePath);
}
