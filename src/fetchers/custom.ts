import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { FetchedContent } from "../types";
import { fetchParamObjectToCliArgs } from "../fetch-params";
import { Fetcher } from "./types";

/** Marks a fetcher that only a runner-aware host may execute, e.g. `<fetcher>.requires-runner`. */
export const REQUIRES_RUNNER_SUFFIX = ".requires-runner";

export const DEFAULT_CUSTOM_FETCHER_TIMEOUT_MS = 120_000;

export interface CustomFetcherRunContext {
  executablePath: string;
  channelId: string;
  fetchParams: Record<string, string> | undefined;
  /** Working directory. The runner must leave its output in `<tempDir>/outs`. */
  tempDir: string;
  /** True when the fetcher is marked as needing a runner that understands it. */
  requiresRunner: boolean;
}

/** Runs a custom fetcher so that its items end up in `<tempDir>/outs`. Throws on failure. */
export type CustomFetcherRunner = (context: CustomFetcherRunContext) => Promise<void>;

export interface CustomFetchOptions {
  /** Replaces the default behavior of executing the fetcher as a process. */
  runner?: CustomFetcherRunner;
  /** Wall-clock limit for the default runner. */
  timeoutMs?: number;
}

export interface ExecuteCustomFetcherOptions {
  timeoutMs?: number;
  /** Added to the process environment, after `RES_CHANNEL_ID`. */
  env?: Record<string, string>;
}

/** Runs the fetcher as a process in `context.tempDir`. For runners that decide to allow that. */
export function executeCustomFetcher(
  context: CustomFetcherRunContext,
  options: ExecuteCustomFetcherOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CUSTOM_FETCHER_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(context.executablePath, fetchParamObjectToCliArgs(context.fetchParams), {
      cwd: context.tempDir,
      env: { ...process.env, RES_CHANNEL_ID: context.channelId, ...options.env },
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, () => child.kill("SIGKILL"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Custom fetcher timed out after ${timeoutMs} ms`));
      else if (code === 0) resolve();
      else reject(new Error(`Custom fetcher failed (${signal ?? `exit code ${code}`}): ${stderr.trim()}`));
    });
  });
}

function runDefault(context: CustomFetcherRunContext, timeoutMs: number): Promise<void> {
  if (context.requiresRunner) {
    return Promise.reject(
      new Error(
        `Custom fetcher '${path.basename(context.executablePath)}' requires a sandbox-capable host and cannot be run directly.`,
      ),
    );
  }
  return executeCustomFetcher(context, { timeoutMs });
}

function killProcessTree(pid: number | undefined, fallback: () => void): void {
  try {
    if (pid !== undefined && process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else fallback();
  } catch {
    fallback();
  }
}

interface DiscoveredItem {
  markdownPath: string;
  sourceFileName: string;
}

function listMarkdownItems(outsDir: string): DiscoveredItem[] {
  if (!fs.existsSync(outsDir)) return [];
  return fs
    .readdirSync(outsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => ({
      markdownPath: path.join(outsDir, entry.name),
      sourceFileName: entry.name,
    }));
}

function collectSupplementaryFiles(
  resourcesRoot: string,
): Array<{ relativePath: string; content: Buffer }> {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  const stack: string[] = [""];

  while (stack.length > 0) {
    const relativeDir = stack.pop()!;
    const absoluteDir = path.join(resourcesRoot, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.join(relativeDir, entry.name);
      const absolutePath = path.join(resourcesRoot, relativePath);
      if (entry.isDirectory()) {
        stack.push(relativePath);
        continue;
      }
      if (entry.isFile()) {
        files.push({
          relativePath,
          content: fs.readFileSync(absolutePath),
        });
      }
    }
  }

  return files;
}

export async function fetchCustom(
  executablePath: string,
  channelId: string,
  fetchParams: Record<string, string> | undefined,
  options: CustomFetchOptions = {},
): Promise<FetchedContent[]> {
  const executableAbsolutePath = path.resolve(executablePath);
  if (!fs.existsSync(executableAbsolutePath)) {
    throw new Error(`Custom fetcher not found: ${executableAbsolutePath}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "res-fetch-custom-"));
  const outsDir = path.join(tempDir, "outs");
  fs.mkdirSync(outsDir, { recursive: true });

  try {
    const context: CustomFetcherRunContext = {
      executablePath: executableAbsolutePath,
      channelId,
      fetchParams,
      tempDir,
      requiresRunner: fs.existsSync(executableAbsolutePath + REQUIRES_RUNNER_SUFFIX),
    };
    await (options.runner
      ? options.runner(context)
      : runDefault(context, options.timeoutMs ?? DEFAULT_CUSTOM_FETCHER_TIMEOUT_MS));

    const items = listMarkdownItems(outsDir).map((entry) => {
      const content = fs.readFileSync(entry.markdownPath, "utf-8");
      const stem = path.basename(entry.sourceFileName, ".md") || "content";
      const resourceDir = path.join(outsDir, stem);

      return {
        content,
        sourceFileName: entry.sourceFileName,
        supplementaryFiles: fs.existsSync(resourceDir)
          ? collectSupplementaryFiles(resourceDir)
          : [],
      };
    });

    return items;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function createCustomFetcher(
  executablePath: string,
  options: CustomFetchOptions = {},
): Fetcher {
  return {
    fetch(fetchParams, channelId, _options?: any) {
      return fetchCustom(executablePath, channelId, fetchParams, options);
    },
  };
}
