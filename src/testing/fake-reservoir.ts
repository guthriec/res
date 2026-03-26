import type { ChannelConfig, Channel, ContentItem, ReservoirConfig } from "../types";
import { GLOBAL_LOCK_NAME } from "../types";
import { ContentParser } from "../content-parser";
import type {
  Reservoir,
  ChannelController,
  ContentController,
  LockController,
  EvictionController,
} from "../interfaces";

interface FakeState {
  channels: Map<string, Channel>;
  content: ContentItem[];
  config: ReservoirConfig;
  fetchResults: Map<string, ContentItem[]>;
}

class ChannelControllerFake implements ChannelController {
  constructor(private readonly state: FakeState) {}

  async addChannel(config: ChannelConfig): Promise<Channel> {
    const slug =
      config.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "channel";
    let id = slug;
    let suffix = 2;
    while (this.state.channels.has(id)) {
      id = `${slug}-${suffix}`;
      suffix++;
    }
    const channel: Channel = {
      id,
      createdAt: new Date().toISOString(),
      name: config.name,
      fetchMethod: config.fetchMethod,
      fetchParams: config.fetchParams,
      rateLimitInterval: config.rateLimitInterval,
      refreshInterval: config.refreshInterval ?? 86400,
      idField: config.idField,
      duplicateStrategy: config.duplicateStrategy ?? "keep-both",
      retainedLocks: config.retainedLocks ?? [],
    };
    this.state.channels.set(id, channel);
    return channel;
  }

  async editChannel(channelId: string, updates: Partial<ChannelConfig>): Promise<Channel> {
    const existing = this.viewChannel(channelId);
    const updated: Channel = {
      ...existing,
      ...updates,
      id: channelId,
      createdAt: existing.createdAt,
    };
    this.state.channels.set(channelId, updated);
    return updated;
  }

  async deleteChannel(channelId: string): Promise<void> {
    if (!this.state.channels.has(channelId)) {
      throw new Error(`Channel not found: ${channelId}`);
    }
    this.state.channels.delete(channelId);
    this.state.content = this.state.content.filter((item) => item.channelId !== channelId);
  }

  viewChannel(channelId: string): Channel {
    const channel = this.state.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    return channel;
  }

  listChannels(): Channel[] {
    return Array.from(this.state.channels.values());
  }
}

class ContentControllerFake implements ContentController {
  constructor(private readonly state: FakeState) {}

  listContent(
    options: {
      channelIds?: string[];
      retained?: boolean;
      retainedBy?: string[];
      pageSize?: number;
      pageOffset?: number;
    } = {},
  ): ContentItem[] {
    let items = this.state.content;
    if (options.channelIds) {
      const ids = new Set(options.channelIds);
      items = items.filter((item) => ids.has(item.channelId));
    }
    if (options.retained === true) {
      items = items.filter((item) => item.locks.length > 0);
    } else if (options.retained === false) {
      items = items.filter((item) => item.locks.length === 0);
    }
    if (options.retainedBy && options.retainedBy.length > 0) {
      const retainedBySet = new Set(options.retainedBy);
      items = items.filter((item) => item.locks.some((lock) => retainedBySet.has(lock)));
    }
    const pageOffset = options.pageOffset ?? 0;
    if (options.pageSize === undefined) {
      return items.slice(pageOffset);
    }
    return items.slice(pageOffset, pageOffset + options.pageSize);
  }

  listRetained(channelIds?: string[]): ContentItem[] {
    return this.listContent({ channelIds, retained: true });
  }

  readContentFrontmatterMap(contentId: string): Record<string, string> {
    const item = this.state.content.find((candidate) => candidate.id === contentId);
    if (!item) {
      throw new Error(`Content not found: ${contentId}`);
    }

    return ContentParser.parseInlineFrontmatter(item.content);
  }

  readContentFrontmatter(contentId: string, key: string): string | undefined {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error("Frontmatter key must not be empty");
    }

    const fields = this.readContentFrontmatterMap(contentId);
    return fields[normalizedKey];
  }

  async writeContentFrontmatter(
    contentId: string,
    updates: Record<string, string | null>,
  ): Promise<ContentItem> {
    const item = this.state.content.find((candidate) => candidate.id === contentId);
    if (!item) {
      throw new Error(`Content not found: ${contentId}`);
    }

    const content = ContentParser.writeInlineFrontmatter(item.content, updates);

    const updated: ContentItem = {
      ...item,
      content,
    };
    const index = this.state.content.findIndex((candidate) => candidate.id === contentId);
    this.state.content[index] = updated;
    return updated;
  }
}

class LockControllerFake implements LockController {
  constructor(private readonly state: FakeState) {}

  async retainContent(contentId: string, lockName: string = GLOBAL_LOCK_NAME): Promise<void> {
    const item = this.state.content.find((i) => i.id === contentId);
    if (!item) throw new Error(`Content not found: ${contentId}`);
    if (!item.locks.includes(lockName)) {
      item.locks = [...item.locks, lockName];
    }
  }

  async releaseContent(contentId: string, lockName: string = GLOBAL_LOCK_NAME): Promise<void> {
    const item = this.state.content.find((i) => i.id === contentId);
    if (!item) throw new Error(`Content not found: ${contentId}`);
    item.locks = item.locks.filter((name) => name !== lockName);
  }

  async retainContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): Promise<number> {
    return this.updateRange({ ...options, retain: true });
  }

  async releaseContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): Promise<number> {
    return this.updateRange({ ...options, retain: false });
  }

  async retainChannel(channelId: string, lockName: string = GLOBAL_LOCK_NAME): Promise<Channel> {
    const channel = this.state.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    const retainedLocks = channel.retainedLocks.includes(lockName)
      ? channel.retainedLocks
      : [...channel.retainedLocks, lockName];
    const updated = { ...channel, retainedLocks };
    this.state.channels.set(channelId, updated);
    return updated;
  }

  async releaseChannel(channelId: string, lockName: string = GLOBAL_LOCK_NAME): Promise<Channel> {
    const channel = this.state.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    const retainedLocks = channel.retainedLocks.filter((name) => name !== lockName);
    const updated = { ...channel, retainedLocks };
    this.state.channels.set(channelId, updated);
    return updated;
  }

  private updateRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
    retain: boolean;
  }): number {
    const { fromId, toId, channelId, retain } = options;
    const lockName = options.lockName ?? GLOBAL_LOCK_NAME;
    const fromIdNum = fromId ? Number(fromId) : -Infinity;
    const toIdNum = toId ? Number(toId) : Infinity;

    if (fromId && isNaN(fromIdNum)) throw new Error(`Invalid start ID: ${fromId}`);
    if (toId && isNaN(toIdNum)) throw new Error(`Invalid end ID: ${toId}`);
    if (fromIdNum > toIdNum)
      throw new Error(`Invalid range: fromId (${fromId}) comes after toId (${toId})`);

    let candidates = this.state.content;
    if (channelId) {
      candidates = candidates.filter((i) => i.channelId === channelId);
    }

    let foundFrom = !fromId;
    let foundTo = !toId;
    let count = 0;

    for (const item of candidates) {
      const itemIdNum = Number(item.id);
      if (isNaN(itemIdNum)) continue;
      if (fromId && item.id === fromId) foundFrom = true;
      if (toId && item.id === toId) foundTo = true;
      if (itemIdNum >= fromIdNum && itemIdNum <= toIdNum) {
        if (retain) {
          if (!item.locks.includes(lockName)) item.locks = [...item.locks, lockName];
        } else {
          item.locks = item.locks.filter((name) => name !== lockName);
        }
        count++;
      }
    }

    if (!foundFrom) throw new Error(`Start ID not found: ${fromId}`);
    if (!foundTo) throw new Error(`End ID not found: ${toId}`);
    return count;
  }
}

class EvictionControllerFake implements EvictionController {
  constructor(private readonly state: FakeState) {}

  clean(): void {
    const maxSizeMB = this.state.config.maxSizeMB;
    if (maxSizeMB === undefined) return;
    this.state.content = this.state.content.filter((item) => item.locks.length > 0);
  }
}

/**
 * In-memory implementation of {@link Reservoir} for use in tests.
 *
 * All state is held in memory. Use {@link seedContent} to pre-populate
 * content and {@link setFetchResult} to control what {@link fetchChannel}
 * returns.
 */
export class ReservoirFake implements Reservoir {
  private readonly state: FakeState;
  readonly channelController: ChannelController;
  readonly contentController: ContentController;
  readonly lockController: LockController;
  readonly evictionController: EvictionController;
  readonly directory = "/fake/reservoir";
  readonly customFetchersDirectory = "/fake/fetchers";

  constructor() {
    this.state = {
      channels: new Map(),
      content: [],
      config: {},
      fetchResults: new Map(),
    };
    this.channelController = new ChannelControllerFake(this.state);
    this.contentController = new ContentControllerFake(this.state);
    this.lockController = new LockControllerFake(this.state);
    this.evictionController = new EvictionControllerFake(this.state);
  }

  get reservoirConfig(): ReservoirConfig {
    return { ...this.state.config };
  }

  initialize(options: { maxSizeMB?: number } = {}): Reservoir {
    if (options.maxSizeMB !== undefined) {
      this.state.config = { ...this.state.config, maxSizeMB: options.maxSizeMB };
    }
    return this;
  }

  load(): Reservoir {
    return this;
  }

  async setMaxSizeMB(maxSizeMB: number): Promise<ReservoirConfig> {
    this.state.config = { ...this.state.config, maxSizeMB };
    return this.reservoirConfig;
  }

  addFetcher(executablePath: string): { name: string; destinationPath: string } {
    const name = executablePath.split("/").pop() ?? "fetcher";
    return { name, destinationPath: `${this.customFetchersDirectory}/${name}` };
  }

  async fetchChannel(channelId: string): Promise<ContentItem[]> {
    const results = this.state.fetchResults.get(channelId) ?? [];
    for (const item of results) {
      if (!this.state.content.find((c) => c.id === item.id)) {
        this.state.content.push({ ...item });
      }
    }
    return results;
  }

  // ─── Test helpers ─────────────────────────────────────────────────────────

  /**
   * Seeds a content item directly into the fake, bypassing fetch.
   */
  seedContent(item: ContentItem): void {
    this.state.content.push({ ...item });
  }

  /**
   * Configures what {@link fetchChannel} will return (and add to content)
   * for the given channel.
   */
  setFetchResult(channelId: string, items: ContentItem[]): void {
    this.state.fetchResults.set(channelId, items);
  }
}
