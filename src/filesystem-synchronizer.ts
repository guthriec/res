import * as fs from 'fs';
import * as path from 'path';
import { ContentIdAllocator } from './content-id-allocator';
import { ChannelController } from './channel-controller';
import { Logger } from './logger';
import { RelativePathHelper } from './relative-path-helper';

interface FilesystemSynchronizerDependencies {
  reservoirDir: string;
  idAllocator: ContentIdAllocator;
  channelController: ChannelController;
}

export class FilesystemSynchronizer {
  private readonly reservoirDir: string;
  private readonly idAllocator: ContentIdAllocator;
  private readonly channelController: ChannelController;

  constructor(deps: FilesystemSynchronizerDependencies) {
    this.reservoirDir = deps.reservoirDir;
    this.idAllocator = deps.idAllocator;
    this.channelController = deps.channelController;
  }

  async syncContentTracking(): Promise<void> {
    const logger = Logger.fromEnvironment();
    const channels = this.channelController.listChannels();
    const allMappings = this.idAllocator.listMappings();
    const staleIds = Object.entries(allMappings)
      .filter(([, relPath]) => !fs.existsSync(path.join(this.reservoirDir, relPath)))
      .map(([id]) => id);
    await Promise.all(staleIds.map((id) => this.idAllocator.removeMappingById(id)));

    for (const channel of channels) {
      const metadata = this.channelController.loadMetadata(channel.id);
      let metadataChanged = false;
      let orphanedRemoved = 0;
      let recordsUpdated = 0;
      metadata.items = metadata.items.filter((item) => {
        const mappedRelativePath = this.idAllocator.getFileForId(item.id);
        const candidatePath = mappedRelativePath ?? item.filePath;
        if (!candidatePath) {
          metadataChanged = true;
          orphanedRemoved += 1;
          return false;
        }
        const normalizedCandidatePath = RelativePathHelper.normalizeRelativePath(candidatePath);
        const exists = fs.existsSync(path.join(this.reservoirDir, normalizedCandidatePath));
        if (!exists) {
          metadataChanged = true;
          orphanedRemoved += 1;
        }
        return exists;
      });

      const seenIds = new Set<string>();

      for (const item of metadata.items) {
        const mappedRelativePath = this.idAllocator.getFileForId(item.id);
        const relativePath = RelativePathHelper.normalizeRelativePath(mappedRelativePath ?? item.filePath ?? '');
        if (!relativePath) continue;
        const absolutePath = path.join(this.reservoirDir, relativePath);
        if (!fs.existsSync(absolutePath)) continue;
        seenIds.add(item.id);

        if (item.filePath !== relativePath) {
          item.filePath = relativePath;
          metadataChanged = true;
          recordsUpdated += 1;
        }
        if (!item.fetchedAt || item.fetchedAt.trim().length === 0) {
          item.fetchedAt = fs.statSync(absolutePath).mtime.toISOString();
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
        this.channelController.saveMetadata(channel.id, metadata);
        logger.debug(
          `[res sync] [${channel.id}] wrote metadata (removed=${orphanedRemoved}, updated=${recordsUpdated}, items=${metadata.items.length})`,
        );
      } else {
        logger.debug(`[res sync] [${channel.id}] no metadata changes`);
      }
    }
  }
}