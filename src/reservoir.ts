import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ReservoirConfig,
  ChannelConfig,
  Channel,
  DuplicateStrategy,
  ContentMetadata,
  ContentItem,
  FetchedContent,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  DEFAULT_DUPLICATE_STRATEGY,
  GLOBAL_LOCK_NAME,
} from './types';
import { getBuiltinFetcher } from './fetchers';
import { createCustomFetcher } from './fetchers/custom';
import { Fetcher } from './fetchers/types';
import { ContentIdAllocator } from './content-id-allocator';

const CONFIG_FILE = '.res-config.json';
const CHANNELS_DIR = 'channels';
const CHANNEL_CONFIG_FILE = 'channel.json';
const CHANNEL_METADATA_FILE = 'metadata.json';
const CONTENT_DIR = 'content';
const CUSTOM_FETCHERS_DIR = 'fetchers';

function resolveUserConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'res');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, 'res');
    }
  }
  return path.join(os.homedir(), '.config', 'res');
}

interface ContentLockState {
  id: string;
  locks: string[];
  filePath?: string;
  fetchedAt: string;
  url?: string;
}

interface ParsedContentFile {
  id: string;
  content: string;
  filePath: string;
}

interface ExistingContentEntry {
  filePath: string;
  contentId?: string;
}

function normalizeFetchArgs(fetchArgs?: Record<string, string>): Record<string, string> {
  if (!fetchArgs || typeof fetchArgs !== 'object' || Array.isArray(fetchArgs)) return {};
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(fetchArgs)) {
    if (typeof rawValue !== 'string') continue;
    const key = rawKey.trim();
    if (!key) continue;
    normalized[key] = rawValue.trim();
  }
  return normalized;
}

function channelDirectorySlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'channel';
}

function contentFileSlug(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'content';
}

function parseMaybeJsonString(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

function parseInlineFrontmatter(rawContent: string): Record<string, string> {
  if (!rawContent.startsWith('---\n')) return {};
  const endIdx = rawContent.indexOf('\n---\n', 4);
  if (endIdx === -1) return {};

  const header = rawContent.slice(4, endIdx).split('\n');
  const fields: Record<string, string> = {};

  for (const line of header) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    const value = line.slice(sep + 1).trim();
    fields[key] = parseMaybeJsonString(value);
  }

  return fields;
}

function normalizeIdField(idField?: string): string | undefined {
  if (typeof idField !== 'string') return undefined;
  const normalized = idField.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDuplicateStrategy(value?: DuplicateStrategy | string): DuplicateStrategy {
  if (value === undefined) return DEFAULT_DUPLICATE_STRATEGY;
  if (value === 'overwrite' || value === 'keep both') return value;
  throw new Error(`Invalid duplicate strategy '${value}'. Expected 'overwrite' or 'keep both'.`);
}

function normalizeChannel(rawChannel: Channel | (Omit<Channel, 'refreshInterval'> & { refreshInterval?: number })): Channel {
  const raw = rawChannel as Channel & { retentionStrategy?: unknown };
  const rawRefresh = raw.refreshInterval;
  const refreshInterval =
    typeof rawRefresh === 'number' && Number.isFinite(rawRefresh) && rawRefresh > 0
      ? rawRefresh
      : DEFAULT_REFRESH_INTERVAL_SECONDS;
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    name: raw.name,
    fetchMethod: raw.fetchMethod,
    fetchArgs: normalizeFetchArgs(raw.fetchArgs),
    rateLimitInterval: typeof raw.rateLimitInterval === 'number' ? raw.rateLimitInterval : undefined,
    refreshInterval,
    idField: normalizeIdField(raw.idField),
    duplicateStrategy: normalizeDuplicateStrategy(raw.duplicateStrategy),
    retainedLocks: normalizeLocks(rawChannel.retainedLocks),
  };
}

function normalizeLockName(lockName?: string): string {
  if (lockName === undefined) return GLOBAL_LOCK_NAME;
  const normalized = lockName.trim();
  if (normalized.includes(',')) {
    throw new Error("Invalid lock name: commas are not allowed");
  }
  return normalized.length > 0 ? normalized : GLOBAL_LOCK_NAME;
}

function normalizeLocks(lockNames?: string[], options: { validateNames?: boolean } = {}): string[] {
  if (!Array.isArray(lockNames) || lockNames.length === 0) return [];
  const validateNames = options.validateNames ?? false;
  const unique = new Set<string>();
  for (const lockName of lockNames) {
    if (typeof lockName !== 'string') continue;
    const normalized = lockName.trim();
    if (!normalized) continue;
    if (validateNames && normalized.includes(',')) {
      throw new Error("Invalid lock name: commas are not allowed");
    }
    unique.add(normalized);
  }
  return [...unique];
}

function isSyncDebugEnabled(): boolean {
  const logLevel = process.env.RES_LOG_LEVEL?.trim().toLowerCase();
  if (logLevel === 'debug') {
    return true;
  }

  const legacy = process.env.RES_DEBUG_SYNC?.trim().toLowerCase();
  if (!legacy) return false;
  return legacy === '1' || legacy === 'true' || legacy === 'yes' || legacy === 'on';
}

export class Reservoir {
  private readonly dir: string;
  private config: ReservoirConfig;
  private readonly idAllocator: ContentIdAllocator;

  private constructor(dir: string, config: ReservoirConfig) {
    this.dir = dir;
    this.config = config;
    this.idAllocator = ContentIdAllocator.forReservoir(dir);
  }

  /**
   * Initialize a new reservoir at the given directory.
   * Creates the directory if it doesn't exist.
   */
  static initialize(dir: string, options: { maxSizeMB?: number } = {}): Reservoir {
    const absDir = path.resolve(dir);
    if (!fs.existsSync(absDir)) {
      fs.mkdirSync(absDir, { recursive: true });
    }
    const config: ReservoirConfig = {};
    if (options.maxSizeMB !== undefined) {
      config.maxSizeMB = options.maxSizeMB;
    }
    fs.writeFileSync(path.join(absDir, CONFIG_FILE), JSON.stringify(config, null, 2));
    fs.mkdirSync(path.join(absDir, CHANNELS_DIR), { recursive: true });
    return new Reservoir(absDir, config);
  }

  /**
   * Load an existing reservoir from the given directory.
   */
  static load(dir: string): Reservoir {
    const absDir = path.resolve(dir);
    const configPath = path.join(absDir, CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      throw new Error(`No reservoir found at ${absDir}. Run 'res init' first.`);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ReservoirConfig;
    return new Reservoir(absDir, config);
  }

  /**
   * Find and load the nearest initialized reservoir by searching the given directory
   * and its parent directories.
   */
  static loadNearest(startDir: string = process.cwd()): Reservoir {
    const nearestDir = Reservoir.findNearestDirectory(startDir);
    if (!nearestDir) {
      const absStart = path.resolve(startDir);
      throw new Error(`No reservoir found from ${absStart} upward. Run 'res init' in this directory or pass --dir <path>.`);
    }
    return Reservoir.load(nearestDir);
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
    return path.join(resolveUserConfigDir(), CUSTOM_FETCHERS_DIR);
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

  // ─── Channel management ────────────────────────────────────────────────────

  addChannel(config: ChannelConfig): Channel {
    const channelsDir = path.join(this.dir, CHANNELS_DIR);
    const baseDirName = channelDirectorySlug(config.name);
    let channelDirName = baseDirName;
    let suffix = 2;
    while (fs.existsSync(path.join(channelsDir, channelDirName))) {
      channelDirName = `${baseDirName}-${suffix}`;
      suffix += 1;
    }

    const channel: Channel = {
      id: channelDirName,
      createdAt: new Date().toISOString(),
      name: config.name,
      fetchMethod: config.fetchMethod,
      fetchArgs: normalizeFetchArgs(config.fetchArgs),
      rateLimitInterval: config.rateLimitInterval,
      refreshInterval: config.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS,
      idField: normalizeIdField(config.idField),
      duplicateStrategy: normalizeDuplicateStrategy(config.duplicateStrategy),
      retainedLocks: normalizeLocks(config.retainedLocks, { validateNames: true }),
    };

    const channelDir = path.join(channelsDir, channelDirName);
    fs.mkdirSync(path.join(channelDir, CONTENT_DIR), { recursive: true });
    fs.writeFileSync(path.join(channelDir, CHANNEL_CONFIG_FILE), JSON.stringify(channel, null, 2));
    fs.writeFileSync(path.join(channelDir, CHANNEL_METADATA_FILE), JSON.stringify({ items: [] }, null, 2));
    return channel;
  }

  editChannel(channelId: string, updates: Partial<ChannelConfig>): Channel {
    const existing = this.viewChannel(channelId);
    const normalizedUpdates: Partial<ChannelConfig> = { ...updates };
    if (updates.idField !== undefined) {
      normalizedUpdates.idField = normalizeIdField(updates.idField);
    }
    if (updates.duplicateStrategy !== undefined) {
      normalizedUpdates.duplicateStrategy = normalizeDuplicateStrategy(updates.duplicateStrategy);
    }
    if (updates.retainedLocks !== undefined) {
      normalizedUpdates.retainedLocks = normalizeLocks(updates.retainedLocks, { validateNames: true });
    }
    const updated: Channel = normalizeChannel({ ...existing, ...normalizedUpdates });
    const channelDir = this.resolveChannelDir(channelId);
    fs.writeFileSync(path.join(channelDir, CHANNEL_CONFIG_FILE), JSON.stringify(updated, null, 2));
    return updated;
  }

  deleteChannel(channelId: string): void {
    const channelDir = this.resolveChannelDir(channelId);
    fs.rmSync(channelDir, { recursive: true, force: true });
  }

  viewChannel(channelId: string): Channel {
    const configPath = path.join(this.resolveChannelDir(channelId), CHANNEL_CONFIG_FILE);
    const rawChannel = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Channel;
    const channel = normalizeChannel(rawChannel);
    if (rawChannel.refreshInterval !== channel.refreshInterval) {
      fs.writeFileSync(configPath, JSON.stringify(channel, null, 2));
    }
    return channel;
  }

  listChannels(): Channel[] {
    const channelsDir = path.join(this.dir, CHANNELS_DIR);
    if (!fs.existsSync(channelsDir)) return [];
    return fs
      .readdirSync(channelsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        try {
          const configPath = path.join(channelsDir, e.name, CHANNEL_CONFIG_FILE);
          if (!fs.existsSync(configPath)) return [];
          const rawChannel = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Channel;
          const channel = normalizeChannel(rawChannel);
          if (rawChannel.refreshInterval !== channel.refreshInterval) {
            fs.writeFileSync(configPath, JSON.stringify(channel, null, 2));
          }
          return [channel];
        } catch {
          return [];
        }
      });
  }

  // ─── Fetch / refresh ──────────────────────────────────────────────────────

  async fetchChannel(channelId: string): Promise<ContentItem[]> {
    await this.syncContentTracking();
    const channel = this.viewChannel(channelId);
    const fetchArgs = channel.fetchArgs;
    const fetcher = this.resolveFetcher(channel.fetchMethod);
    const fetched: FetchedContent[] = await fetcher.fetch(fetchArgs, channelId);

    // Persist fetched items
    const metadata = this.loadMetadata(channelId);
    const channelDir = this.resolveChannelDir(channelId);
    const contentDir = path.join(channelDir, CONTENT_DIR);
    const persisted: ContentItem[] = [];
    const metadataById = new Map(metadata.items.map((entry) => [entry.id, entry]));
    const existingByDedupeKey = this.buildExistingContentByDedupeKey(channelId, channel.idField);

    for (const item of fetched) {
      const dedupeKey = this.resolveDedupeKeyForFetchedItem(item, channel.idField);
      const existingEntry = existingByDedupeKey.get(dedupeKey);
      const shouldOverwrite = channel.duplicateStrategy === 'overwrite' && existingEntry !== undefined;

      let id: string;
      let locks: string[];
      let contentPath: string;

      if (shouldOverwrite && existingEntry) {
        id = existingEntry.contentId ?? await this.idAllocator.assignIdToFile(this.toRelativePath(existingEntry.filePath));
        const existingState = metadataById.get(id);
        if (existingState) {
          locks = [...existingState.locks];
          existingState.url = item.url;
          existingState.fetchedAt = new Date().toISOString();
          existingState.filePath = this.toRelativePath(existingEntry.filePath);
        } else {
          locks = [...channel.retainedLocks];
          const lockState: ContentLockState = {
            id,
            locks: [...locks],
            fetchedAt: new Date().toISOString(),
            url: item.url,
            filePath: this.toRelativePath(existingEntry.filePath),
          };
          metadata.items.push(lockState);
          metadataById.set(id, lockState);
        }
        contentPath = existingEntry.filePath;
      } else {
        contentPath = this.createUniqueContentPath(contentDir, this.contentFileStemForFetchedItem(item));
        id = await this.idAllocator.assignIdToFile(this.toRelativePath(contentPath));
        locks = [...channel.retainedLocks];
        const lockState: ContentLockState = {
          id,
          locks: [...locks],
          fetchedAt: new Date().toISOString(),
          url: item.url,
          filePath: this.toRelativePath(contentPath),
        };
        metadata.items.push(lockState);
        metadataById.set(id, lockState);
      }

      const fetchedAt = new Date().toISOString();
      const state = metadataById.get(id);
      if (state) {
        state.fetchedAt = fetchedAt;
        state.url = item.url;
        state.filePath = this.toRelativePath(contentPath);
      }

      await this.idAllocator.setMapping(id, this.toRelativePath(contentPath));
      fs.writeFileSync(contentPath, item.content);
      existingByDedupeKey.set(dedupeKey, { filePath: contentPath, contentId: id });

      const resourceDirectoryName = path.basename(contentPath, '.md');
      if (resourceDirectoryName.length > 0) {
        const destinationRoot = path.join(contentDir, resourceDirectoryName);
        if (shouldOverwrite && fs.existsSync(destinationRoot)) {
          fs.rmSync(destinationRoot, { recursive: true, force: true });
        }
        if (Array.isArray(item.supplementaryFiles) && item.supplementaryFiles.length > 0) {
          for (const file of item.supplementaryFiles) {
            const destinationPath = path.join(destinationRoot, file.relativePath);
            fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
            fs.writeFileSync(destinationPath, file.content);
          }
        }
      }

      persisted.push({
        id,
        channelId,
        title: this.inferTitleFromFileName(contentPath),
        fetchedAt,
        locks,
        url: item.url,
        content: item.content,
      });
    }
    if (persisted.length > 0) {
      this.saveMetadata(channelId, metadata);
      if (isSyncDebugEnabled()) {
        console.error(`[res sync] [${channelId}] wrote metadata after fetch (${persisted.length} item(s))`);
      }
    } else if (isSyncDebugEnabled()) {
      console.error(`[res sync] [${channelId}] skipped metadata write after fetch (0 items)`);
    }
    return persisted;
  }

  // ─── Content management ───────────────────────────────────────────────────

  listContent(options: {
    channelIds?: string[];
    retained?: boolean;
    retainedBy?: string[];
    pageSize?: number;
    pageOffset?: number;
  } = {}): ContentItem[] {
    const channels = options.channelIds ? options.channelIds.map((id) => this.viewChannel(id)) : this.listChannels();
    const retained = options.retained;
    const normalizedRetainedBy = options.retainedBy
      ?.map((name) => name.trim())
      .filter((name) => name.length > 0);
    const retainedBySet = normalizedRetainedBy && normalizedRetainedBy.length > 0
      ? new Set(normalizedRetainedBy)
      : undefined;
    const pageOffset = options.pageOffset ?? 0;
    const pageSize = options.pageSize;

    const results: ContentItem[] = [];
    for (const channel of channels) {
      const parsedById = this.readContentFilesById(channel.id);
      for (const state of this.loadMetadata(channel.id).items) {
        const isRetained = state.locks.length > 0;
        if (retained === true && !isRetained) continue;
        if (retained === false && isRetained) continue;
        if (retainedBySet && !state.locks.some((name) => retainedBySet.has(name))) continue;

        const parsed = parsedById.get(state.id);
        if (!parsed) continue;
        const relativePath = this.toRelativePath(parsed.filePath);
        results.push({
          id: state.id,
          channelId: channel.id,
          title: this.inferTitleFromFileName(parsed.filePath),
          fetchedAt: state.fetchedAt,
          url: state.url,
          locks: [...state.locks],
          content: parsed.content,
          filePath: relativePath,
        });
      }
    }

    if (pageSize === undefined) {
      return results.slice(pageOffset);
    }

    return results.slice(pageOffset, pageOffset + pageSize);
  }

  listRetained(channelIds?: string[]): ContentItem[] {
    return this.listContent({ channelIds, retained: true });
  }

  retainContent(contentId: string, lockName?: string): void {
    this.updateContentLock(contentId, normalizeLockName(lockName), true);
  }

  releaseContent(contentId: string, lockName?: string): void {
    this.updateContentLock(contentId, normalizeLockName(lockName), false);
  }

  /**
   * Retain multiple content items by ID range.
   * @param options.fromId - Start ID (inclusive, optional for open-ended ranges)
   * @param options.toId - End ID (inclusive, optional for open-ended ranges)
   * @param options.channelId - Optional channel filter
   * @param options.lockName - Lock name to apply (defaults to [global])
   * @returns Number of items retained
   */
  retainContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): number {
    return this.updateContentLockRange({ ...options, retain: true });
  }

  /**
   * Release multiple content items by ID range.
   * @param options.fromId - Start ID (inclusive, optional for open-ended ranges)
   * @param options.toId - End ID (inclusive, optional for open-ended ranges)
   * @param options.channelId - Optional channel filter
   * @param options.lockName - Lock name to remove (defaults to [global])
   * @returns Number of items released
   */
  releaseContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): number {
    return this.updateContentLockRange({ ...options, retain: false });
  }

  retainChannel(channelId: string, lockName?: string): Channel {
    const channel = this.viewChannel(channelId);
    const normalized = normalizeLockName(lockName);
    const retainedLocks = normalizeLocks([...channel.retainedLocks, normalized]);
    const updated: Channel = { ...channel, retainedLocks };
    fs.writeFileSync(
      path.join(this.resolveChannelDir(channelId), CHANNEL_CONFIG_FILE),
      JSON.stringify(updated, null, 2),
    );
    return updated;
  }

  releaseChannel(channelId: string, lockName?: string): Channel {
    const channel = this.viewChannel(channelId);
    const normalized = normalizeLockName(lockName);
    const retainedLocks = channel.retainedLocks.filter((name) => name !== normalized);
    const updated: Channel = { ...channel, retainedLocks };
    fs.writeFileSync(
      path.join(this.resolveChannelDir(channelId), CHANNEL_CONFIG_FILE),
      JSON.stringify(updated, null, 2),
    );
    return updated;
  }

  /**
   * Deletes content files that exceed the configured max size.
   * Prioritises deleting content that the retention strategy allows removal of,
   * starting with the oldest items.
   */
  clean(): void {
    if (!this.config.maxSizeMB) return;
    const maxBytes = this.config.maxSizeMB * 1024 * 1024;
    const channelsDir = path.join(this.dir, CHANNELS_DIR);
    if (this.getDirSize(channelsDir) <= maxBytes) return;

    type Candidate = Omit<ContentMetadata, 'channelId'> & { channelId: string; filePath: string };
    const candidates: Candidate[] = [];

    for (const channel of this.listChannels()) {
      const parsedById = this.readContentFilesById(channel.id);
      for (const item of this.loadMetadata(channel.id).items) {
        const parsed = parsedById.get(item.id);
        if (!parsed) continue;
        if (item.locks.length === 0) {
          candidates.push({
            id: item.id,
            channelId: channel.id,
            fetchedAt: item.fetchedAt,
            url: item.url,
            locks: item.locks,
            filePath: parsed.filePath,
          });
        }
      }
    }

    // Oldest first
    candidates.sort((a, b) => new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime());

    let totalSize = this.getDirSize(channelsDir);
    for (const candidate of candidates) {
      if (totalSize <= maxBytes) break;
      if (fs.existsSync(candidate.filePath)) {
        totalSize -= fs.statSync(candidate.filePath).size;
        fs.unlinkSync(candidate.filePath);
        this.removeFromMetadata(candidate.channelId, candidate.id);
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private loadMetadata(channelId: string): { items: ContentLockState[] } {
    const metaPath = path.join(this.resolveChannelDir(channelId), CHANNEL_METADATA_FILE);
    if (!fs.existsSync(metaPath)) return { items: [] };

    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
      items?: Array<
        ContentMetadata |
        (ContentLockState & { read?: boolean; fileName?: string }) |
        { id: string; read: boolean }
      >
    };
    const items = Array.isArray(raw.items) ? raw.items : [];

    const lockStateItems: ContentLockState[] = [];
    let needsWrite = false;

    for (const item of items) {
      if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') {
        needsWrite = true;
        continue;
      }

      if ('locks' in item && Array.isArray(item.locks)) {
        const locks = normalizeLocks(item.locks);
        const entry = item as ContentLockState & { fileName?: string };
        const fetchedAt = typeof entry.fetchedAt === 'string' && entry.fetchedAt.trim().length > 0
          ? entry.fetchedAt
          : new Date().toISOString();
        const filePathRaw = typeof entry.filePath === 'string'
          ? entry.filePath
          : typeof entry.fileName === 'string'
            ? path.join(CHANNELS_DIR, channelId, CONTENT_DIR, entry.fileName)
            : undefined;
        const filePath = filePathRaw ? this.normalizeRelativePath(filePathRaw) : undefined;

        lockStateItems.push({
          id: item.id,
          locks,
          fetchedAt,
          url: typeof entry.url === 'string' ? entry.url : undefined,
          filePath,
        });
        if (locks.length !== item.locks.length) {
          needsWrite = true;
        }
        if (fetchedAt !== entry.fetchedAt || filePath !== entry.filePath) {
          needsWrite = true;
        }
        continue;
      }

      if ('read' in item && typeof item.read === 'boolean') {
        const locks = item.read ? [] : [GLOBAL_LOCK_NAME];
        lockStateItems.push({
          id: item.id,
          locks,
          fetchedAt: new Date().toISOString(),
        });
        needsWrite = true;
        continue;
      }

      const legacyItem = item as ContentMetadata;
      const legacyRead = (legacyItem as { read?: boolean }).read;
      const locks = legacyRead === false ? [GLOBAL_LOCK_NAME] : [];
      lockStateItems.push({
        id: legacyItem.id,
        locks,
        fetchedAt: legacyItem.fetchedAt,
        url: legacyItem.url,
      });
      needsWrite = true;
    }

    if (needsWrite) {
      const migrated = { items: lockStateItems };
      this.saveMetadata(channelId, migrated);
      return migrated;
    }

    return { items: lockStateItems };
  }

  private saveMetadata(channelId: string, metadata: { items: ContentLockState[] }): void {
    fs.writeFileSync(
      path.join(this.resolveChannelDir(channelId), CHANNEL_METADATA_FILE),
      JSON.stringify(metadata, null, 2),
    );
  }

  private resolveChannelDir(channelId: string): string {
    const channelsDir = path.join(this.dir, CHANNELS_DIR);
    if (!fs.existsSync(channelsDir)) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const directPath = path.join(channelsDir, channelId);
    const directConfigPath = path.join(directPath, CHANNEL_CONFIG_FILE);
    if (fs.existsSync(directConfigPath)) {
      try {
        const channel = JSON.parse(fs.readFileSync(directConfigPath, 'utf-8')) as Channel;
        if (channel.id === channelId) {
          return directPath;
        }
      } catch {
        // fall back to legacy directory scan
      }
    }

    const entries = fs.readdirSync(channelsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidateDir = path.join(channelsDir, entry.name);
      const configPath = path.join(candidateDir, CHANNEL_CONFIG_FILE);
      if (!fs.existsSync(configPath)) continue;
      try {
        const channel = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Channel;
        if (channel.id === channelId) {
          return candidateDir;
        }
      } catch {
        continue;
      }
    }

    throw new Error(`Channel not found: ${channelId}`);
  }

  private findItem(contentId: string): { channelId: string; index: number } | null {
    for (const channel of this.listChannels()) {
      const meta = this.loadMetadata(channel.id);
      const idx = meta.items.findIndex((i) => i.id === contentId);
      if (idx !== -1) return { channelId: channel.id, index: idx };
    }
    return null;
  }

  private updateContentLock(contentId: string, lockName: string, retain: boolean): void {
    const found = this.findItem(contentId);
    if (!found) throw new Error(`Content not found: ${contentId}`);
    const meta = this.loadMetadata(found.channelId);
    const item = meta.items[found.index];
    if (retain) {
      item.locks = normalizeLocks([...item.locks, lockName]);
    } else {
      item.locks = item.locks.filter((name) => name !== lockName);
    }
    this.saveMetadata(found.channelId, meta);
  }

  private updateContentLockRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
    retain: boolean;
  }): number {
    const { fromId, toId, channelId, lockName, retain } = options;
    const normalized = normalizeLockName(lockName);
    const channels = channelId ? [this.viewChannel(channelId)] : this.listChannels();
    
    // Validate range boundaries exist
    const fromIdNum = fromId ? Number(fromId) : -Infinity;
    const toIdNum = toId ? Number(toId) : Infinity;
    
    if (fromId && isNaN(fromIdNum)) throw new Error(`Invalid start ID: ${fromId}`);
    if (toId && isNaN(toIdNum)) throw new Error(`Invalid end ID: ${toId}`);
    if (fromIdNum > toIdNum) throw new Error(`Invalid range: fromId (${fromId}) comes after toId (${toId})`);
    
    let foundFrom = !fromId;
    let foundTo = !toId;
    let count = 0;
    const metaByChannel = new Map<string, { items: ContentLockState[] }>();
    
    // Process items in each channel
    for (const channel of channels) {
      if (!metaByChannel.has(channel.id)) {
        metaByChannel.set(channel.id, this.loadMetadata(channel.id));
      }
      const meta = metaByChannel.get(channel.id)!;
      
      for (const item of meta.items) {
        const itemIdNum = Number(item.id);
        if (isNaN(itemIdNum)) continue;
        
        // Check if this item matches the range boundaries
        if (fromId && item.id === fromId) foundFrom = true;
        if (toId && item.id === toId) foundTo = true;
        
        // Check if item is in range
        if (itemIdNum >= fromIdNum && itemIdNum <= toIdNum) {
          if (retain) {
            item.locks = normalizeLocks([...item.locks, normalized]);
          } else {
            item.locks = item.locks.filter((name) => name !== normalized);
          }
          count++;
        }
      }
    }
    
    // Verify range boundaries were found
    if (!foundFrom) throw new Error(`Start ID not found: ${fromId}`);
    if (!foundTo) throw new Error(`End ID not found: ${toId}`);
    
    // Save all modified metadata files
    for (const [chId, meta] of metaByChannel.entries()) {
      this.saveMetadata(chId, meta);
    }
    
    return count;
  }

  private removeFromMetadata(channelId: string, contentId: string): void {
    const meta = this.loadMetadata(channelId);
    meta.items = meta.items.filter((i) => i.id !== contentId);
    this.saveMetadata(channelId, meta);
  }

  private getDirSize(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((acc, entry) => {
      const p = path.join(dir, entry.name);
      return acc + (entry.isDirectory() ? this.getDirSize(p) : fs.statSync(p).size);
    }, 0);
  }

  private contentFileStemForFetchedItem(item: FetchedContent): string {
    if (item.sourceFileName && item.sourceFileName.trim().length > 0) {
      return path.basename(item.sourceFileName, path.extname(item.sourceFileName));
    }
    if (item.title && item.title.trim().length > 0) {
      return contentFileSlug(item.title);
    }
    if (item.url && item.url.trim().length > 0) {
      return contentFileSlug(item.url);
    }
    return 'content';
  }

  private resolveDedupeKeyForFetchedItem(item: FetchedContent, idField?: string): string {
    const configuredIdField = normalizeIdField(idField);
    if (configuredIdField) {
      const fields = parseInlineFrontmatter(item.content);
      const value = fields[configuredIdField]?.trim();
      if (value && value.length > 0) {
        return value;
      }
    }
    return this.contentFileStemForFetchedItem(item);
  }

  private buildExistingContentByDedupeKey(channelId: string, idField?: string): Map<string, ExistingContentEntry> {
    const configuredIdField = normalizeIdField(idField);
    const entries = new Map<string, ExistingContentEntry>();
    const contentDir = path.join(this.resolveChannelDir(channelId), CONTENT_DIR);
    if (!fs.existsSync(contentDir)) return entries;
    const metadataById = new Map(this.loadMetadata(channelId).items.map((item) => [item.id, item]));

    for (const entry of fs.readdirSync(contentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const filePath = path.join(contentDir, entry.name);
      const relativePath = this.toRelativePath(filePath);
      const contentId = this.idAllocator.findIdByFile(relativePath);
      let key: string | undefined;
      if (configuredIdField) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const bodyFields = parseInlineFrontmatter(raw);
        const bodyValue = bodyFields[configuredIdField]?.trim();
        if (bodyValue && bodyValue.length > 0) {
          key = bodyValue;
        }
      }
      if (!key) {
        key = path.basename(filePath, '.md');
      }
      const metadataFilePath = contentId ? metadataById.get(contentId)?.filePath : undefined;
      const resolvedContentId = contentId
        ?? (metadataFilePath ? this.idAllocator.findIdByFile(metadataFilePath) : undefined);
      entries.set(key, { filePath, contentId: resolvedContentId });
    }

    return entries;
  }

  private createUniqueContentPath(contentDir: string, fileStem: string): string {
    const base = contentFileSlug(fileStem);
    let candidate = path.join(contentDir, `${base}.md`);
    let suffix = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(contentDir, `${base}-${suffix}.md`);
      suffix += 1;
    }
    return candidate;
  }

  private readContentFilesById(channelId: string): Map<string, ParsedContentFile> {
    const contentDir = path.join(this.resolveChannelDir(channelId), CONTENT_DIR);
    const parsedById = new Map<string, ParsedContentFile>();
    if (!fs.existsSync(contentDir)) return parsedById;

    const metadataById = new Map(this.loadMetadata(channelId).items.map((item) => [item.id, item]));

    for (const entry of fs.readdirSync(contentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const filePath = path.join(contentDir, entry.name);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const relativePath = this.toRelativePath(filePath);
      const mappedId = this.idAllocator.findIdByFile(relativePath);

      if (mappedId) {
        parsedById.set(mappedId, {
          id: mappedId,
          content: raw,
          filePath,
        });
        continue;
      }

      for (const state of metadataById.values()) {
        if (state.filePath !== relativePath) continue;
        parsedById.set(state.id, {
          id: state.id,
          content: raw,
          filePath,
        });
        break;
      }
    }

    return parsedById;
  }

  private normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/');
  }

  private toRelativePath(filePath: string): string {
    return this.normalizeRelativePath(path.relative(this.dir, filePath));
  }

  private inferTitleFromFileName(filePath: string): string {
    const stem = path.basename(filePath, '.md');
    const title = stem
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return title.length > 0 ? title : 'content';
  }

  async syncContentTracking(): Promise<void> {
    const channels = this.listChannels();
    const allMappings = this.idAllocator.listMappings();
    const staleIds = Object.entries(allMappings)
      .filter(([, relPath]) => !fs.existsSync(path.join(this.dir, relPath)))
      .map(([id]) => id);
    await Promise.all(staleIds.map((id) => this.idAllocator.removeMappingById(id)));

    for (const channel of channels) {
      const channelDir = this.resolveChannelDir(channel.id);
      const contentDir = path.join(channelDir, CONTENT_DIR);
      const channelContentPrefix = this.normalizeRelativePath(path.join(CHANNELS_DIR, channel.id, CONTENT_DIR)) + '/';
      if (!fs.existsSync(contentDir)) {
        fs.mkdirSync(contentDir, { recursive: true });
      }

      const metadata = this.loadMetadata(channel.id);
      let metadataChanged = false;
      let orphanedRemoved = 0;
      let discoveredAdded = 0;
      let recordsUpdated = 0;
      metadata.items = metadata.items.filter((item) => {
        const mappedRelativePath = this.idAllocator.getFileForId(item.id);
        const candidatePath = mappedRelativePath ?? item.filePath;
        if (!candidatePath) {
          metadataChanged = true;
          orphanedRemoved += 1;
          return false;
        }
        const normalizedCandidatePath = this.normalizeRelativePath(candidatePath);
        if (!normalizedCandidatePath.startsWith(channelContentPrefix)) {
          metadataChanged = true;
          orphanedRemoved += 1;
          return false;
        }
        const exists = fs.existsSync(path.join(this.dir, normalizedCandidatePath));
        if (!exists) {
          metadataChanged = true;
          orphanedRemoved += 1;
        }
        return exists;
      });

      const byId = new Map(metadata.items.map((item) => [item.id, item]));
      const seenIds = new Set<string>();

      for (const entry of fs.readdirSync(contentDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        const filePath = path.join(contentDir, entry.name);
        const relativePath = this.toRelativePath(filePath);
        let id = this.idAllocator.findIdByFile(relativePath);
        if (!id) {
          id = await this.idAllocator.assignIdToFile(relativePath);
        }

        seenIds.add(id);
        const existing = byId.get(id);
        if (!existing) {
          const stat = fs.statSync(filePath);
          const created: ContentLockState = {
            id,
            locks: [...channel.retainedLocks],
            fetchedAt: stat.mtime.toISOString(),
            filePath: relativePath,
          };
          metadata.items.push(created);
          byId.set(id, created);
          metadataChanged = true;
          discoveredAdded += 1;
          continue;
        }

        if (existing.filePath !== relativePath) {
          existing.filePath = relativePath;
          metadataChanged = true;
          recordsUpdated += 1;
        }
        if (!existing.fetchedAt || existing.fetchedAt.trim().length === 0) {
          existing.fetchedAt = fs.statSync(filePath).mtime.toISOString();
          metadataChanged = true;
          recordsUpdated += 1;
        }
      }

      const filtered = metadata.items.filter((item) => seenIds.has(item.id));
      if (filtered.length !== metadata.items.length) {
        orphanedRemoved += metadata.items.length - filtered.length;
        metadata.items = filtered;
        metadataChanged = true;
      }
      if (metadataChanged) {
        this.saveMetadata(channel.id, metadata);
        if (isSyncDebugEnabled()) {
          console.error(
            `[res sync] [${channel.id}] wrote metadata (removed=${orphanedRemoved}, added=${discoveredAdded}, updated=${recordsUpdated}, items=${metadata.items.length})`,
          );
        }
      } else if (isSyncDebugEnabled()) {
        console.error(`[res sync] [${channel.id}] no metadata changes`);
      }
    }
  }

  private resolveFetcher(fetchMethod: string): Fetcher {
    const builtinFetcher = getBuiltinFetcher(fetchMethod);
    if (builtinFetcher) {
      return builtinFetcher;
    }

    return createCustomFetcher(path.join(this.customFetchersDirectory, fetchMethod));
  }
}
