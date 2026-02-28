import * as fs from 'fs';
import * as path from 'path';
import {
  ChannelConfig,
  Channel,
  ContentMetadata,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  GLOBAL_LOCK_NAME,
} from './types';
import { ContentIdAllocator } from './content-id-allocator';
import { normalizeFetchParams } from './fetch-params';
import { InputNormalizer } from './input-normalizer';
import { ContentLockState, ParsedContentFile } from './reservoir-internal-types';
import { RelativePathHelper } from './relative-path-helper';

const RES_METADATA_DIR = '.res';
const CHANNELS_DIR = 'channels';
const CHANNEL_CONFIG_FILE = 'channel.json';
const CHANNEL_METADATA_FILE = 'metadata.json';

function channelDirectorySlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'channel';
}

export class ChannelController {
  private readonly idAllocator: ContentIdAllocator;

  constructor(private readonly directory: string) {
    this.idAllocator = ContentIdAllocator.forReservoir(directory);
  }

  loadMetadata(channelId: string): { items: ContentLockState[] } {
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
        const locks = InputNormalizer.locks(item.locks);
        const entry = item as ContentLockState & { fileName?: string };
        const fetchedAt = typeof entry.fetchedAt === 'string' && entry.fetchedAt.trim().length > 0
          ? entry.fetchedAt
          : new Date().toISOString();
        const filePathRaw = typeof entry.filePath === 'string'
          ? entry.filePath
          : typeof entry.fileName === 'string'
            ? `${entry.fileName.replace(/\.md$/i, '')}.md`
            : undefined;
        const filePath = filePathRaw ? RelativePathHelper.normalizeRelativePath(filePathRaw) : undefined;

        lockStateItems.push({
          id: item.id,
          locks,
          fetchedAt,
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

  saveMetadata(channelId: string, metadata: { items: ContentLockState[] }): void {
    fs.writeFileSync(
      path.join(this.resolveChannelDir(channelId), CHANNEL_METADATA_FILE),
      JSON.stringify(metadata, null, 2),
    );
  }

  removeFromMetadata(channelId: string, contentId: string): void {
    const metadata = this.loadMetadata(channelId);
    metadata.items = metadata.items.filter((item) => item.id !== contentId);
    this.saveMetadata(channelId, metadata);
  }

  readContentFilesById(channelId: string): Map<string, ParsedContentFile> {
    const parsedById = new Map<string, ParsedContentFile>();
    const metadataById = new Map(this.loadMetadata(channelId).items.map((item) => [item.id, item]));

    for (const state of metadataById.values()) {
      const mappedPath = this.idAllocator.getFileForId(state.id);
      const candidate = mappedPath ?? state.filePath;
      if (!candidate) continue;
      const normalized = RelativePathHelper.normalizeRelativePath(candidate);
      const absolutePath = path.join(this.directory, normalized);
      if (!fs.existsSync(absolutePath) || !absolutePath.toLowerCase().endsWith('.md')) continue;
      const raw = fs.readFileSync(absolutePath, 'utf-8');
      parsedById.set(state.id, {
        id: state.id,
        content: raw,
        filePath: absolutePath,
      });
    }

    return parsedById;
  }

  resolveChannelContentRoot(channelId: string): string {
    return path.join(this.directory, channelId);
  }

  resolveChannelMetadataRoot(): string {
    return path.join(this.directory, RES_METADATA_DIR, CHANNELS_DIR);
  }

  resolveChannelDir(channelId: string): string {
    const channelsDir = this.resolveChannelMetadataRoot();
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
        // fall back to directory scan
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

  addChannel(config: ChannelConfig): Channel {
    const channelsDir = this.resolveChannelMetadataRoot();
    fs.mkdirSync(channelsDir, { recursive: true });
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
      fetchParams: normalizeFetchParams(config.fetchParams),
      rateLimitInterval: config.rateLimitInterval,
      refreshInterval: config.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS,
      idField: InputNormalizer.idField(config.idField),
      duplicateStrategy: InputNormalizer.duplicateStrategy(config.duplicateStrategy),
      retainedLocks: InputNormalizer.locks(config.retainedLocks, { validateNames: true }),
    };

    const channelDir = path.join(channelsDir, channelDirName);
    fs.mkdirSync(channelDir, { recursive: true });
    fs.writeFileSync(path.join(channelDir, CHANNEL_CONFIG_FILE), JSON.stringify(channel, null, 2));
    fs.writeFileSync(path.join(channelDir, CHANNEL_METADATA_FILE), JSON.stringify({ items: [] }, null, 2));
    return channel;
  }

  editChannel(channelId: string, updates: Partial<ChannelConfig>): Channel {
    const existing = this.viewChannel(channelId);
    const normalizedUpdates: Partial<ChannelConfig> = { ...updates };
    if (updates.idField !== undefined) {
      normalizedUpdates.idField = InputNormalizer.idField(updates.idField);
    }
    if (updates.duplicateStrategy !== undefined) {
      normalizedUpdates.duplicateStrategy = InputNormalizer.duplicateStrategy(updates.duplicateStrategy);
    }
    if (updates.retainedLocks !== undefined) {
      normalizedUpdates.retainedLocks = InputNormalizer.locks(updates.retainedLocks, { validateNames: true });
    }
    const updated: Channel = InputNormalizer.channel({ ...existing, ...normalizedUpdates });
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
    const rawChannel = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Channel & { fetchArgs?: Record<string, string> };
    const channel = InputNormalizer.channel(rawChannel);
    if (rawChannel.refreshInterval !== channel.refreshInterval || rawChannel.fetchArgs !== undefined) {
      fs.writeFileSync(configPath, JSON.stringify(channel, null, 2));
    }
    return channel;
  }

  listChannels(): Channel[] {
    const channelsDir = this.resolveChannelMetadataRoot();
    if (!fs.existsSync(channelsDir)) return [];
    return fs
      .readdirSync(channelsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        try {
          const configPath = path.join(channelsDir, e.name, CHANNEL_CONFIG_FILE);
          if (!fs.existsSync(configPath)) return [];
          const rawChannel = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Channel & { fetchArgs?: Record<string, string> };
          const channel = InputNormalizer.channel(rawChannel);
          if (rawChannel.refreshInterval !== channel.refreshInterval || rawChannel.fetchArgs !== undefined) {
            fs.writeFileSync(configPath, JSON.stringify(channel, null, 2));
          }
          return [channel];
        } catch {
          return [];
        }
      });
  }
}
