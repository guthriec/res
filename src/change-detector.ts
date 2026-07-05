import * as fs from "fs";
import * as path from "path";
import { VersionStore, type VersionSidecar, type ContentVersion } from "./version-store";
import { ContentIdAllocator } from "./content-id-allocator";
import { createDirectoryWatcher } from "./file-watcher";
import { Logger } from "./logger";
import { RelativePathHelper } from "./relative-path-helper";

const RESERVOIR_META_DIR = ".res";

/**
 * Returns true when a path (relative to the reservoir root) should be skipped.
 */
function shouldSkipRelativePath(relPath: string): boolean {
  return relPath.startsWith(RESERVOIR_META_DIR) || relPath.startsWith(".");
}

export class ChangeDetector {
  private readonly reservoirDir: string;
  private readonly versionStore: VersionStore;
  private readonly idAllocator: ContentIdAllocator;
  private readonly relativePathHelper: RelativePathHelper;
  private readonly logger: Logger;
  private cleanupWatcher: (() => void) | undefined;

  constructor(reservoirDir: string) {
    this.reservoirDir = path.resolve(reservoirDir);
    this.versionStore = new VersionStore(this.reservoirDir);
    this.idAllocator = ContentIdAllocator.forReservoir(this.reservoirDir);
    this.relativePathHelper = new RelativePathHelper(this.reservoirDir);
    this.logger = Logger.fromEnvironment();
  }

  /**
   * Scan all tracked files in the reservoir and record new versions for any
   * file whose on-disk hash differs from the sidecar's tip hash.
   *
   * Also records tombstones for deleted files that still have sidecars.
   */
  async scanAll(): Promise<void> {
    const mdFiles = this.collectMdFiles();
    const sidecarPaths = this.collectSidecarPaths();

    // Process all .md files: record new versions if changed or if new
    for (const mdPath of mdFiles) {
      try {
        await this.recordVersionIfChanged(mdPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`[change-detector] failed to record version for ${mdPath}: ${message}`);
      }
    }

    // Process sidecars: tombstone any where the .md is gone
    for (const scPath of sidecarPaths) {
      const mdPath = scPath.replace(/\.res-version\.json$/, "");
      if (!fs.existsSync(mdPath)) {
        const alreadyTombstoned = this.versionStore.isTombstoned(mdPath);
        if (!alreadyTombstoned) {
          try {
            await this.appendTombstone(mdPath);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.debug(
              `[change-detector] failed to tombstone ${mdPath}: ${message}`,
            );
          }
        }
      }
    }
  }

  /**
   * Start watching the reservoir's content directories for changes.
   * The watcher triggers a full scan whenever a filesystem event occurs.
   *
   * Returns a cleanup function that stops watching. Idempotent.
   */
  startWatching(): () => void {
    if (this.cleanupWatcher) {
      return this.cleanupWatcher;
    }

    const stopWatcher = createDirectoryWatcher(this.reservoirDir, () => {
      this.scanAll().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[change-detector] scan failed: ${message}`);
      });
    });

    const cleanup = (): void => {
      if (this.cleanupWatcher) {
        stopWatcher();
        this.cleanupWatcher = undefined;
      }
    };
    this.cleanupWatcher = cleanup;
    return cleanup;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Collect all .md file paths in the reservoir (recursively, excluding .res/).
   */
  private collectMdFiles(): string[] {
    const results: string[] = [];

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(this.reservoirDir, absPath);
        if (shouldSkipRelativePath(relPath)) continue;

        if (entry.isDirectory()) {
          walk(absPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          if (!entry.name.endsWith(".res-version.json")) {
            results.push(absPath);
          }
        }
      }
    };

    walk(this.reservoirDir);
    return results;
  }

  /**
   * Collect all .res-version.json sidecar file paths in the reservoir.
   */
  private collectSidecarPaths(): string[] {
    const results: string[] = [];

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(this.reservoirDir, absPath);
        if (shouldSkipRelativePath(relPath)) continue;

        if (entry.isDirectory()) {
          walk(absPath);
        } else if (entry.isFile() && entry.name.endsWith(".res-version.json")) {
          results.push(absPath);
        }
      }
    };

    walk(this.reservoirDir);
    return results;
  }

  /**
   * Compare a file's on-disk hash against its sidecar tip.
   * Record a new version if the hash differs, or create an initial sidecar
   * if none exists.
   */
  private async recordVersionIfChanged(mdPath: string): Promise<void> {
    const currentHash = VersionStore.hashFile(mdPath);
    if (currentHash === null) return; // file no longer present, handled by sidecar pass

    const sidecar = this.versionStore.read(mdPath);

    if (!sidecar) {
      await this.createInitialSidecar(mdPath, currentHash);
      return;
    }

    const tip = sidecar.chain[sidecar.chain.length - 1];
    if (tip.hash === currentHash) return; // unchanged

    this.appendVersion(sidecar, tip.id, currentHash);
    await this.versionStore.write(mdPath, sidecar);
    this.logger.debug(`[change-detector] recorded new version for ${mdPath}`);
  }

  /**
   * Tombstone a file: append a version with hash: null to the sidecar chain.
   */
  private async appendTombstone(mdPath: string): Promise<void> {
    const sidecar = this.versionStore.read(mdPath);
    if (!sidecar) return;

    const tip = sidecar.chain[sidecar.chain.length - 1];
    if (tip.hash === null) return; // already tombstoned

    this.appendVersion(sidecar, tip.id, null);
    await this.versionStore.write(mdPath, sidecar);
    this.logger.debug(`[change-detector] tombstoned ${mdPath}`);
  }

  private async createInitialSidecar(mdPath: string, hash: string): Promise<void> {
    const relPath = this.relativePathHelper.toRelativePath(mdPath);
    let contentId = this.idAllocator.findIdByFile(relPath);
    if (!contentId) {
      contentId = await this.idAllocator.assignIdToFile(relPath);
    }

    const now = new Date().toISOString();
    const sidecar: VersionSidecar = {
      contentId,
      chain: [{ id: "v1", parentIds: [], hash, timestamp: now }],
    };

    await this.versionStore.write(mdPath, sidecar);
    this.logger.debug(`[change-detector] created initial sidecar for ${mdPath}`);
  }

  private appendVersion(
    sidecar: VersionSidecar,
    parentId: string,
    hash: string | null,
  ): void {
    const now = new Date().toISOString();
    const nextId = `v${sidecar.chain.length + 1}`;

    sidecar.chain.push({
      id: nextId,
      parentIds: [parentId],
      hash,
      timestamp: now,
    });
  }
}
