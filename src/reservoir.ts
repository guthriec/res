import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ReservoirConfig,
  ChannelConfig,
  Channel,
  ContentMetadata,
  ContentItem,
  FetchedContent,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  GLOBAL_LOCK_NAME,
} from './types';
import { fetchRSS } from './fetchers/rss';
import { fetchWebPage } from './fetchers/webpage';
import { fetchCustom } from './fetchers/custom';
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
}

interface ContentFrontmatter {
  id: string;
  channelId: string;
  title: string;
  fetchedAt: string;
  url?: string;
}

interface ParsedContentFile {
  meta: ContentFrontmatter;
  content: string;
  filePath: string;
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

function toFrontmatter(meta: ContentFrontmatter, content: string): string {
  const lines = [
    '---',
    `id: ${JSON.stringify(meta.id)}`,
    `channelId: ${JSON.stringify(meta.channelId)}`,
    `title: ${JSON.stringify(meta.title)}`,
    `fetchedAt: ${JSON.stringify(meta.fetchedAt)}`,
  ];
  if (meta.url !== undefined) {
    lines.push(`url: ${JSON.stringify(meta.url)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${content}`;
}

function parseFrontmatter(rawContent: string): { meta: ContentFrontmatter | null; content: string } {
  if (!rawContent.startsWith('---\n')) {
    return { meta: null, content: rawContent };
  }

  const endIdx = rawContent.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    return { meta: null, content: rawContent };
  }

  const header = rawContent.slice(4, endIdx).split('\n');
  const body = rawContent.slice(endIdx + '\n---\n'.length);
  const kv: Record<string, string> = {};

  for (const line of header) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    kv[key] = value;
  }

  const id = kv.id;
  const channelId = kv.channelId;
  const title = kv.title;
  const fetchedAt = kv.fetchedAt;
  if (!id || !channelId || !title || !fetchedAt) {
    return { meta: null, content: rawContent };
  }

  const parseMaybeJsonString = (value: string): string => {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : value;
    } catch {
      return value;
    }
  };

  return {
    meta: {
      id: parseMaybeJsonString(id),
      channelId: parseMaybeJsonString(channelId),
      title: parseMaybeJsonString(title),
      fetchedAt: parseMaybeJsonString(fetchedAt),
      url: kv.url !== undefined ? parseMaybeJsonString(kv.url) : undefined,
    },
    content: body,
  };
}

function normalizeChannel(rawChannel: Channel | (Omit<Channel, 'refreshInterval'> & { refreshInterval?: number })): Channel {
  const { retentionStrategy: _retentionStrategy, ...rest } = rawChannel as Channel & { retentionStrategy?: unknown };
  const rawRefresh = rest.refreshInterval;
  const refreshInterval =
    typeof rawRefresh === 'number' && Number.isFinite(rawRefresh) && rawRefresh > 0
      ? rawRefresh
      : DEFAULT_REFRESH_INTERVAL_SECONDS;
  const fetchArgs = Array.isArray(rest.fetchArgs)
    ? rest.fetchArgs.filter((value) => typeof value === 'string').map((value) => value.trim()).filter((value) => value.length > 0)
    : [];
  return {
    ...rest,
    fetchArgs,
    refreshInterval,
    retainedLocks: normalizeLocks(rawChannel.retainedLocks),
  };
}

function normalizeLockName(lockName?: string): string {
  if (lockName === undefined) return GLOBAL_LOCK_NAME;
  const normalized = lockName.trim();
  return normalized.length > 0 ? normalized : GLOBAL_LOCK_NAME;
}

function normalizeLocks(lockNames?: string[]): string[] {
  if (!Array.isArray(lockNames) || lockNames.length === 0) return [];
  const unique = new Set<string>();
  for (const lockName of lockNames) {
    if (typeof lockName !== 'string') continue;
    const normalized = lockName.trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique];
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
      ...config,
      refreshInterval: config.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS,
      retainedLocks: normalizeLocks(config.retainedLocks),
    };

    const channelDir = path.join(channelsDir, channelDirName);
    fs.mkdirSync(path.join(channelDir, CONTENT_DIR), { recursive: true });
    fs.writeFileSync(path.join(channelDir, CHANNEL_CONFIG_FILE), JSON.stringify(channel, null, 2));
    fs.writeFileSync(path.join(channelDir, CHANNEL_METADATA_FILE), JSON.stringify({ items: [] }, null, 2));
    return channel;
  }

  editChannel(channelId: string, updates: Partial<ChannelConfig>): Channel {
    const existing = this.viewChannel(channelId);
    const updated: Channel = normalizeChannel({ ...existing, ...updates });
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
    const channel = this.viewChannel(channelId);
    const fetchArgs = Array.isArray(channel.fetchArgs) ? channel.fetchArgs : [];
    let fetched: FetchedContent[];

    switch (channel.fetchMethod) {
      case 'rss':
        fetched = await fetchRSS(fetchArgs, channelId);
        break;
      case 'web_page':
        fetched = await fetchWebPage(fetchArgs, channelId);
        break;
      default:
        fetched = await fetchCustom(path.join(this.customFetchersDirectory, channel.fetchMethod), channelId, fetchArgs);
        break;
    }

    // Persist fetched items
    const metadata = this.loadMetadata(channelId);
    const channelDir = this.resolveChannelDir(channelId);
    const contentDir = path.join(channelDir, CONTENT_DIR);
    const persisted: ContentItem[] = [];

    for (const item of fetched) {
      const id = await this.idAllocator.nextId();
      const fetchedAt = new Date().toISOString();
      const frontmatter: ContentFrontmatter = {
        id,
        channelId,
        title: item.title,
        fetchedAt,
        url: item.url,
      };
      const locks = [...channel.retainedLocks];
      metadata.items.push({ id, locks });
      const contentPath = this.createUniqueContentPath(contentDir, item.title);
      fs.writeFileSync(contentPath, toFrontmatter(frontmatter, item.content));

      if (Array.isArray(item.supplementaryFiles) && item.supplementaryFiles.length > 0) {
        const contentFileName = item.sourceFileName ?? path.basename(contentPath);
        const resourceDirectoryName = contentFileName.toLowerCase().endsWith('.md')
          ? contentFileName.slice(0, -3)
          : contentFileName;
        if (resourceDirectoryName.length > 0) {
          const destinationRoot = path.join(contentDir, resourceDirectoryName);
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
        title: item.title,
        fetchedAt,
        locks,
        url: item.url,
        content: item.content,
      });
    }
    this.saveMetadata(channelId, metadata);
    return persisted;
  }

  // ─── Content management ───────────────────────────────────────────────────

  listRetained(channelIds?: string[]): ContentItem[] {
    const channels = channelIds ? channelIds.map((id) => this.viewChannel(id)) : this.listChannels();
    const results: ContentItem[] = [];
    for (const channel of channels) {
      const parsedById = this.readContentFilesById(channel.id);
      for (const state of this.loadMetadata(channel.id).items) {
        if (state.locks.length === 0) continue;
        const parsed = parsedById.get(state.id);
        if (!parsed) continue;
        const relativePath = path.relative(this.dir, parsed.filePath);
        results.push({
          ...parsed.meta,
          locks: [...state.locks],
          content: parsed.content,
          filePath: relativePath,
        });
      }
    }
    return results;
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

    type Candidate = ContentMetadata & { filePath: string };
    const candidates: Candidate[] = [];

    for (const channel of this.listChannels()) {
      const parsedById = this.readContentFilesById(channel.id);
      for (const item of this.loadMetadata(channel.id).items) {
        const parsed = parsedById.get(item.id);
        if (!parsed) continue;
        if (item.locks.length === 0) {
          candidates.push({
            ...parsed.meta,
            ...item,
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

    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { items?: Array<ContentMetadata | ContentLockState | { id: string; read: boolean }> };
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
        lockStateItems.push({ id: item.id, locks });
        if (locks.length !== item.locks.length) {
          needsWrite = true;
        }
        continue;
      }

      if ('read' in item && typeof item.read === 'boolean') {
        const locks = item.read ? [] : [GLOBAL_LOCK_NAME];
        lockStateItems.push({ id: item.id, locks });
        needsWrite = true;
        continue;
      }

      const legacyItem = item as ContentMetadata;
      const legacyRead = (legacyItem as { read?: boolean }).read;
      const locks = legacyRead === false ? [GLOBAL_LOCK_NAME] : [];
      lockStateItems.push({ id: legacyItem.id, locks });
      needsWrite = true;
    }

    if (needsWrite) {
      const legacyItems = items.filter(
        (item): item is ContentMetadata =>
          !!item &&
          typeof item === 'object' &&
          'id' in item &&
          'channelId' in item &&
          'title' in item &&
          'fetchedAt' in item,
      );
      if (legacyItems.length > 0) {
        this.migrateLegacyContent(channelId, legacyItems);
      }
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

  private createUniqueContentPath(contentDir: string, title: string): string {
    const base = contentFileSlug(title);
    let candidate = path.join(contentDir, `${base}.md`);
    let suffix = 2;
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

    for (const entry of fs.readdirSync(contentDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const filePath = path.join(contentDir, entry.name);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (!parsed.meta?.id) continue;
      parsedById.set(parsed.meta.id, {
        meta: parsed.meta,
        content: parsed.content,
        filePath,
      });
    }

    return parsedById;
  }

  private migrateLegacyContent(channelId: string, legacyItems: ContentMetadata[]): void {
    const channelDir = this.resolveChannelDir(channelId);
    const contentDir = path.join(channelDir, CONTENT_DIR);
    fs.mkdirSync(contentDir, { recursive: true });

    for (const item of legacyItems) {
      const legacyPath = path.join(contentDir, `${item.id}.md`);
      if (!fs.existsSync(legacyPath)) continue;

      const raw = fs.readFileSync(legacyPath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      const frontmatter: ContentFrontmatter = {
        id: item.id,
        channelId: item.channelId,
        title: item.title,
        fetchedAt: item.fetchedAt,
        url: item.url,
      };
      const body = parsed.meta ? parsed.content : raw;
      const targetPath = this.createUniqueContentPath(contentDir, item.title);
      fs.writeFileSync(targetPath, toFrontmatter(frontmatter, body));
      if (targetPath !== legacyPath) {
        fs.unlinkSync(legacyPath);
      }
    }
  }
}
