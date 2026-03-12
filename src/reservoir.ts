import * as fs from "fs";
import * as path from "path";
import { ReservoirConfig, ContentItem } from "./types";
import { ContentIdAllocator } from "./content-id-allocator";
import { resolveCustomFetchersDirectory } from "./custom-fetcher-config-util";
import { ChannelControllerImpl } from "./channel-controller";
import { ContentControllerImpl } from "./content-controller";
import { LockControllerImpl } from "./lock-controller";
import { EvictionControllerImpl } from "./eviction-controller";
import { FetchOrchestrator } from "./fetch-orchestrator";
import { FilesystemSynchronizer } from "./filesystem-synchronizer";
import type { Reservoir } from "./interfaces";

const CONFIG_FILE = ".res-config.json";
const RES_METADATA_DIR = ".res";
const CHANNELS_DIR = "channels";

export class ReservoirImpl implements Reservoir {
  private readonly dir: string;
  private config: ReservoirConfig;
  private readonly idAllocator: ContentIdAllocator;
  public readonly channelController: ChannelControllerImpl;
  public readonly contentController: ContentControllerImpl;
  public readonly lockController: LockControllerImpl;
  public readonly evictionController: EvictionControllerImpl;
  private readonly fetchOrchestrator: FetchOrchestrator;
  private readonly filesystemSynchronizer: FilesystemSynchronizer;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.config = {};
    this.idAllocator = ContentIdAllocator.forReservoir(this.dir);
    this.channelController = new ChannelControllerImpl(this.dir);
    this.contentController = new ContentControllerImpl(this.channelController, this.dir);
    this.lockController = new LockControllerImpl(this.channelController);
    this.evictionController = new EvictionControllerImpl(
      this.dir,
      () => this.config.maxSizeMB,
      this.channelController,
    );
    this.fetchOrchestrator = new FetchOrchestrator({
      reservoirDir: this.dir,
      customFetchersDirectory: this.customFetchersDirectory,
      idAllocator: this.idAllocator,
      channelController: this.channelController,
      syncContentTracking: () => this.syncContentTracking(),
    });
    this.filesystemSynchronizer = new FilesystemSynchronizer({
      reservoirDir: this.dir,
      idAllocator: this.idAllocator,
      channelController: this.channelController,
    });
  }

  /**
   * Initialize a new reservoir at the given directory.
   * Creates the directory if it doesn't exist.
   */
  initialize(options: { maxSizeMB?: number } = {}): ReservoirImpl {
    const absDir = this.dir;
    if (!fs.existsSync(absDir)) {
      fs.mkdirSync(absDir, { recursive: true });
    }
    const config: ReservoirConfig = {};
    if (options.maxSizeMB !== undefined) {
      config.maxSizeMB = options.maxSizeMB;
    }
    fs.writeFileSync(path.join(absDir, CONFIG_FILE), JSON.stringify(config, null, 2));
    fs.mkdirSync(path.join(absDir, RES_METADATA_DIR, CHANNELS_DIR), { recursive: true });
    this.config = config;
    return this;
  }

  /**
   * Load an existing reservoir from the given directory.
   */
  load(): ReservoirImpl {
    const absDir = this.dir;
    const configPath = path.join(absDir, CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      throw new Error(`No reservoir found at ${absDir}. Run 'res init' first.`);
    }
    this.config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ReservoirConfig;
    return this;
  }

  /**
   * Find and load the nearest initialized reservoir by searching the given directory
   * and its parent directories.
   */
  static loadNearest(startDir: string = process.cwd()): ReservoirImpl {
    const nearestDir = ReservoirImpl.findNearestDirectory(startDir);
    if (!nearestDir) {
      const absStart = path.resolve(startDir);
      throw new Error(
        `No reservoir found from ${absStart} upward. Run 'res init' in this directory or pass --dir <path>.`,
      );
    }
    return new ReservoirImpl(nearestDir).load();
  }

  private static findNearestDirectory(startDir: string): string | null {
    let current = path.resolve(startDir);
    while (true) {
      const configPath = path.join(current, CONFIG_FILE);
      if (fs.existsSync(configPath)) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }

  get directory(): string {
    return this.dir;
  }

  get reservoirConfig(): ReservoirConfig {
    return { ...this.config };
  }

  get customFetchersDirectory(): string {
    return resolveCustomFetchersDirectory();
  }

  async setMaxSizeMB(maxSizeMB: number): Promise<ReservoirConfig> {
    if (!Number.isFinite(maxSizeMB) || maxSizeMB <= 0) {
      throw new Error(`Invalid max size '${maxSizeMB}'. Expected a positive number.`);
    }

    const previousMaxSizeMB = this.config.maxSizeMB;
    this.config = { ...this.config, maxSizeMB };
    await this.saveReservoirConfig();

    if (previousMaxSizeMB !== undefined && maxSizeMB < previousMaxSizeMB) {
      this.evictionController.clean();
    }

    return this.reservoirConfig;
  }

  addFetcher(executablePath: string): { name: string; destinationPath: string } {
    const sourcePath = path.resolve(executablePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Fetcher executable not found: ${sourcePath}`);
    }
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`Fetcher path is not a file: ${sourcePath}`);
    }

    const name = path.basename(sourcePath);
    const fetchersDir = this.customFetchersDirectory;
    const destinationPath = path.join(fetchersDir, name);
    if (fs.existsSync(destinationPath)) {
      throw new Error(`Fetcher already exists: ${name}`);
    }

    fs.mkdirSync(fetchersDir, { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, sourceStat.mode);

    return {
      name,
      destinationPath,
    };
  }

  // ─── Fetch / refresh ──────────────────────────────────────────────────────

  async fetchChannel(channelId: string): Promise<ContentItem[]> {
    return this.fetchOrchestrator.fetchChannel(channelId);
  }

  private async saveReservoirConfig(): Promise<void> {
    await fs.promises.writeFile(
      path.join(this.dir, CONFIG_FILE),
      JSON.stringify(this.config, null, 2),
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Reconciles content ID mappings and per-channel metadata with the current filesystem state.
   *
   * Removes metadata/mappings for missing files and repairs metadata fields (filePath/fetchedAt)
   * when files still exist.
   */
  async syncContentTracking(): Promise<void> {
    await this.filesystemSynchronizer.syncContentTracking();
  }
}
