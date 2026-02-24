import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  ReservoirConfig,
  ChannelConfig,
  Channel,
  ContentMetadata,
  ContentItem,
} from './types';
import { fetchRSS } from './fetchers/rss';
import { fetchWebPage } from './fetchers/webpage';
import { fetchCustom } from './fetchers/custom';

const CONFIG_FILE = '.res-config.json';
const CHANNELS_DIR = 'channels';
const SCRIPTS_DIR = 'scripts';
const CHANNEL_CONFIG_FILE = 'channel.json';
const CHANNEL_METADATA_FILE = 'metadata.json';
const CONTENT_DIR = 'content';

export class Reservoir {
  private readonly dir: string;
  private config: ReservoirConfig;

  private constructor(dir: string, config: ReservoirConfig) {
    this.dir = dir;
    this.config = config;
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
    fs.mkdirSync(path.join(absDir, SCRIPTS_DIR), { recursive: true });
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

  // ─── Channel management ────────────────────────────────────────────────────

  addChannel(config: ChannelConfig): Channel {
    const id = uuidv4();
    const channel: Channel = { id, createdAt: new Date().toISOString(), ...config };
    const channelDir = path.join(this.dir, CHANNELS_DIR, id);
    fs.mkdirSync(path.join(channelDir, CONTENT_DIR), { recursive: true });
    fs.writeFileSync(path.join(channelDir, CHANNEL_CONFIG_FILE), JSON.stringify(channel, null, 2));
    fs.writeFileSync(path.join(channelDir, CHANNEL_METADATA_FILE), JSON.stringify({ items: [] }, null, 2));
    return channel;
  }

  editChannel(channelId: string, updates: Partial<ChannelConfig>): Channel {
    const existing = this.viewChannel(channelId);
    const updated: Channel = { ...existing, ...updates };
    const channelDir = path.join(this.dir, CHANNELS_DIR, channelId);
    fs.writeFileSync(path.join(channelDir, CHANNEL_CONFIG_FILE), JSON.stringify(updated, null, 2));
    return updated;
  }

  deleteChannel(channelId: string): void {
    this.viewChannel(channelId); // ensure exists
    fs.rmSync(path.join(this.dir, CHANNELS_DIR, channelId), { recursive: true, force: true });
  }

  viewChannel(channelId: string): Channel {
    const configPath = path.join(this.dir, CHANNELS_DIR, channelId, CHANNEL_CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Channel not found: ${channelId}`);
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Channel;
  }

  listChannels(): Channel[] {
    const channelsDir = path.join(this.dir, CHANNELS_DIR);
    if (!fs.existsSync(channelsDir)) return [];
    return fs
      .readdirSync(channelsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        try {
          return [this.viewChannel(e.name)];
        } catch {
          return [];
        }
      });
  }

  // ─── Fetch / refresh ──────────────────────────────────────────────────────

  async fetchChannel(channelId: string): Promise<ContentItem[]> {
    const channel = this.viewChannel(channelId);
    let fetched: ContentItem[];

    switch (channel.fetchMethod) {
      case 'rss':
        if (!channel.url) throw new Error(`Channel ${channelId} has no URL configured`);
        fetched = await fetchRSS(channel.url, channelId);
        break;
      case 'web_page':
        if (!channel.url) throw new Error(`Channel ${channelId} has no URL configured`);
        fetched = await fetchWebPage(channel.url, channelId);
        break;
      case 'custom': {
        if (!channel.script) throw new Error(`Channel ${channelId} has no script configured`);
        const scriptPath = path.join(this.dir, SCRIPTS_DIR, channel.script);
        fetched = await fetchCustom(scriptPath, channelId);
        break;
      }
      default:
        throw new Error(`Unknown fetch method: ${(channel as Channel).fetchMethod}`);
    }

    // Persist fetched items
    const metadata = this.loadMetadata(channelId);
    const existingIds = new Set(metadata.items.map((i) => i.id));

    for (const item of fetched) {
      if (existingIds.has(item.id)) continue;
      const { content, ...meta } = item;
      metadata.items.push(meta);
      const contentPath = path.join(this.dir, CHANNELS_DIR, channelId, CONTENT_DIR, `${item.id}.md`);
      fs.writeFileSync(contentPath, content);
    }
    this.saveMetadata(channelId, metadata);
    return fetched;
  }

  // ─── Content management ───────────────────────────────────────────────────

  listUnread(channelIds?: string[]): ContentItem[] {
    const channels = channelIds ? channelIds.map((id) => this.viewChannel(id)) : this.listChannels();
    const results: ContentItem[] = [];
    for (const channel of channels) {
      for (const item of this.loadMetadata(channel.id).items) {
        if (!item.read) {
          const contentPath = path.join(this.dir, CHANNELS_DIR, channel.id, CONTENT_DIR, `${item.id}.md`);
          results.push({
            ...item,
            content: fs.existsSync(contentPath) ? fs.readFileSync(contentPath, 'utf-8') : '',
          });
        }
      }
    }
    return results;
  }

  markRead(contentId: string): void {
    this.setReadStatus(contentId, true);
  }

  markUnread(contentId: string): void {
    this.setReadStatus(contentId, false);
  }

  /**
   * Marks all content loaded *after* the given content ID as read.
   * Optionally restrict to a single channel.
   */
  markReadAfter(contentId: string, channelId?: string): void {
    this.setReadStatusAfter(contentId, true, channelId);
  }

  /**
   * Marks all content loaded *after* the given content ID as unread.
   * Optionally restrict to a single channel.
   */
  markUnreadAfter(contentId: string, channelId?: string): void {
    this.setReadStatusAfter(contentId, false, channelId);
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
      const { retentionStrategy } = channel;
      for (const item of this.loadMetadata(channel.id).items) {
        const eligible =
          retentionStrategy === 'retain_none' ||
          (retentionStrategy === 'retain_unread' && item.read);
        if (eligible) {
          candidates.push({
            ...item,
            filePath: path.join(channelsDir, channel.id, CONTENT_DIR, `${item.id}.md`),
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

  private loadMetadata(channelId: string): { items: ContentMetadata[] } {
    const metaPath = path.join(this.dir, CHANNELS_DIR, channelId, CHANNEL_METADATA_FILE);
    if (!fs.existsSync(metaPath)) return { items: [] };
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { items: ContentMetadata[] };
  }

  private saveMetadata(channelId: string, metadata: { items: ContentMetadata[] }): void {
    fs.writeFileSync(
      path.join(this.dir, CHANNELS_DIR, channelId, CHANNEL_METADATA_FILE),
      JSON.stringify(metadata, null, 2),
    );
  }

  private findItem(contentId: string): { channelId: string; index: number } | null {
    for (const channel of this.listChannels()) {
      const meta = this.loadMetadata(channel.id);
      const idx = meta.items.findIndex((i) => i.id === contentId);
      if (idx !== -1) return { channelId: channel.id, index: idx };
    }
    return null;
  }

  private setReadStatus(contentId: string, read: boolean): void {
    const found = this.findItem(contentId);
    if (!found) throw new Error(`Content not found: ${contentId}`);
    const meta = this.loadMetadata(found.channelId);
    meta.items[found.index].read = read;
    this.saveMetadata(found.channelId, meta);
  }

  private setReadStatusAfter(contentId: string, read: boolean, channelId?: string): void {
    const channels = channelId ? [this.viewChannel(channelId)] : this.listChannels();
    // Find the reference item's fetchedAt across these channels
    let refFetchedAt: string | undefined;
    for (const ch of channels) {
      const item = this.loadMetadata(ch.id).items.find((i) => i.id === contentId);
      if (item) { refFetchedAt = item.fetchedAt; break; }
    }
    if (!refFetchedAt) throw new Error(`Content not found: ${contentId}`);

    const refTime = new Date(refFetchedAt).getTime();
    for (const ch of channels) {
      const meta = this.loadMetadata(ch.id);
      let changed = false;
      for (const item of meta.items) {
        if (new Date(item.fetchedAt).getTime() > refTime) {
          item.read = read;
          changed = true;
        }
      }
      if (changed) this.saveMetadata(ch.id, meta);
    }
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
}
