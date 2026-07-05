import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { writeJSONAtomic } from "./atomic-writes";

export interface ContentVersion {
  /** Version identifier, monotonic per content document (e.g. "v1", "v2") */
  id: string;
  /** Zero or one parent for linear edits; two or more for merge commits */
  parentIds: string[];
  /** SHA-256 of the full file content. null signals a tombstone (deletion). */
  hash: string | null;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Reserved for multi-user sync */
  author?: string;
}

export interface VersionSidecar {
  /** The ContentIdAllocator-managed document ID for this file */
  contentId: string;
  /** Ordered list of versions forming the DAG (newest last) */
  chain: ContentVersion[];
}

export class VersionStore {
  private readonly reservoirDir: string;

  constructor(reservoirDir: string) {
    this.reservoirDir = path.resolve(reservoirDir);
  }

  /**
   * Compute the SHA-256 hex digest of a file's full content.
   * Returns null if the file does not exist.
   */
  static hashFile(absPath: string): string | null {
    if (!fs.existsSync(absPath)) return null;
    const content = fs.readFileSync(absPath);
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Return the sidecar path for a given .md file path.
   */
  static sidecarPath(mdFilePath: string): string {
    return `${mdFilePath}.res-version.json`;
  }

  /**
   * Read the sidecar for an .md file, or null if no sidecar exists.
   * The sidecar path is derived as `<mdFilePath>.res-version.json`.
   */
  read(mdFilePath: string): VersionSidecar | null {
    const scPath = VersionStore.sidecarPath(mdFilePath);
    if (!fs.existsSync(scPath)) return null;
    try {
      const raw = fs.readFileSync(scPath, "utf-8");
      return JSON.parse(raw) as VersionSidecar;
    } catch {
      return null;
    }
  }

  /**
   * Atomically write a sidecar file.
   */
  async write(mdFilePath: string, sidecar: VersionSidecar): Promise<void> {
    const scPath = VersionStore.sidecarPath(mdFilePath);
    await writeJSONAtomic(scPath, sidecar);
  }

  /**
   * True if a sidecar exists and its chain tip has hash: null (tombstone).
   */
  isTombstoned(mdFilePath: string): boolean {
    const sidecar = this.read(mdFilePath);
    if (!sidecar) return false;
    const tip = sidecar.chain[sidecar.chain.length - 1];
    return tip?.hash === null;
  }

  /**
   * Walk two chains backward to find the last common ancestor version.
   * Returns null if the chains share no common version.
   */
  findLCA(
    localChain: ContentVersion[],
    remoteChain: ContentVersion[],
  ): ContentVersion | null {
    if (localChain.length === 0 || remoteChain.length === 0) return null;

    const localIds = new Set(localChain.map((v) => v.id));
    for (let i = remoteChain.length - 1; i >= 0; i--) {
      if (localIds.has(remoteChain[i].id)) return remoteChain[i];
    }
    return null;
  }
}
