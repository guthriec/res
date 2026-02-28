import * as fs from 'fs';
import * as path from 'path';
import { ContentItem, FetchedContent } from './types';
import { getBuiltinFetcher } from './fetchers';
import { createCustomFetcher } from './fetchers/custom';
import { Fetcher } from './fetchers/types';
import { ContentIdAllocator } from './content-id-allocator';
import { InputNormalizer } from './input-normalizer';
import { ContentParser } from './content-parser';
import { Logger } from './logger';
import { ChannelController } from './channel-controller';
import { ContentLockState } from './reservoir-internal-types';
import { RelativePathHelper } from './relative-path-helper';

interface ExistingContentEntry {
  filePath: string;
  contentId?: string;
}

function contentFileSlug(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'content';
}

interface FetchOrchestratorDependencies {
  reservoirDir: string;
  customFetchersDirectory: string;
  idAllocator: ContentIdAllocator;
  channelController: ChannelController;
  syncContentTracking: () => Promise<void>;
}

export class FetchOrchestrator {
  private readonly reservoirDir: string;
  private readonly customFetchersDirectory: string;
  private readonly idAllocator: ContentIdAllocator;
  private readonly channelController: ChannelController;
  private readonly syncContentTracking: () => Promise<void>;
  private readonly relativePathHelper: RelativePathHelper;

  constructor(deps: FetchOrchestratorDependencies) {
    this.reservoirDir = deps.reservoirDir;
    this.customFetchersDirectory = deps.customFetchersDirectory;
    this.idAllocator = deps.idAllocator;
    this.channelController = deps.channelController;
    this.syncContentTracking = deps.syncContentTracking;
    this.relativePathHelper = new RelativePathHelper(deps.reservoirDir);
  }

  async fetchChannel(channelId: string): Promise<ContentItem[]> {
    const logger = Logger.fromEnvironment();
    await this.syncContentTracking();
    const channel = this.channelController.viewChannel(channelId);
    const fetchParams = channel.fetchParams;
    const fetcher = this.resolveFetcher(channel.fetchMethod);
    const fetched: FetchedContent[] = await fetcher.fetch(fetchParams, channelId);

    const metadata = this.channelController.loadMetadata(channelId);
    const contentRoot = this.channelController.resolveChannelContentRoot(channelId);
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
        id = existingEntry.contentId ?? await this.idAllocator.assignIdToFile(this.relativePathHelper.toRelativePath(existingEntry.filePath));
        const existingState = metadataById.get(id);
        if (existingState) {
          locks = [...existingState.locks];
          existingState.fetchedAt = new Date().toISOString();
          existingState.filePath = this.relativePathHelper.toRelativePath(existingEntry.filePath);
        } else {
          locks = [...channel.retainedLocks];
          const lockState: ContentLockState = {
            id,
            locks: [...locks],
            fetchedAt: new Date().toISOString(),
            filePath: this.relativePathHelper.toRelativePath(existingEntry.filePath),
          };
          metadata.items.push(lockState);
          metadataById.set(id, lockState);
        }
        contentPath = existingEntry.filePath;
      } else {
        contentPath = this.createUniqueContentPath(contentRoot, this.contentFileStemForFetchedItem(item));
        id = await this.idAllocator.assignIdToFile(this.relativePathHelper.toRelativePath(contentPath));
        locks = [...channel.retainedLocks];
        const lockState: ContentLockState = {
          id,
          locks: [...locks],
          fetchedAt: new Date().toISOString(),
          filePath: this.relativePathHelper.toRelativePath(contentPath),
        };
        metadata.items.push(lockState);
        metadataById.set(id, lockState);
      }

      const fetchedAt = new Date().toISOString();
      const state = metadataById.get(id);
      if (state) {
        state.fetchedAt = fetchedAt;
        state.filePath = this.relativePathHelper.toRelativePath(contentPath);
      }

      const resourcesRoot = this.contentResourcesDirectoryForPath(contentPath);
      if (shouldOverwrite && fs.existsSync(resourcesRoot)) {
        fs.rmSync(resourcesRoot, { recursive: true, force: true });
      }
      fs.mkdirSync(path.dirname(contentPath), { recursive: true });

      await this.idAllocator.setMapping(id, this.relativePathHelper.toRelativePath(contentPath));
      fs.writeFileSync(contentPath, item.content);
      existingByDedupeKey.set(dedupeKey, { filePath: contentPath, contentId: id });

      if (Array.isArray(item.supplementaryFiles) && item.supplementaryFiles.length > 0) {
        for (const file of item.supplementaryFiles) {
          const destinationPath = path.join(resourcesRoot, file.relativePath);
          fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
          fs.writeFileSync(destinationPath, file.content);
        }
      }

      persisted.push({
        id,
        channelId,
        title: ContentParser.inferTitleFromContent(item.content),
        fetchedAt,
        locks,
        content: item.content,
      });
    }
    if (persisted.length > 0) {
      this.channelController.saveMetadata(channelId, metadata);
      logger.debug(`[res sync] [${channelId}] wrote metadata after fetch (${persisted.length} item(s))`);
    } else {
      logger.debug(`[res sync] [${channelId}] skipped metadata write after fetch (0 items)`);
    }
    return persisted;
  }

  private contentFileStemForFetchedItem(item: FetchedContent): string {
    if (item.sourceFileName && item.sourceFileName.trim().length > 0) {
      return path.basename(item.sourceFileName, path.extname(item.sourceFileName));
    }
    return 'content';
  }

  private resolveDedupeKeyForFetchedItem(item: FetchedContent, idField?: string): string {
    const configuredIdField = InputNormalizer.idField(idField);
    if (configuredIdField) {
      const fields = ContentParser.parseInlineFrontmatter(item.content);
      const value = fields[configuredIdField]?.trim();
      if (value && value.length > 0) {
        return value;
      }
    }
    return this.contentFileStemForFetchedItem(item);
  }

  private buildExistingContentByDedupeKey(channelId: string, idField?: string): Map<string, ExistingContentEntry> {
    const configuredIdField = InputNormalizer.idField(idField);
    const entries = new Map<string, ExistingContentEntry>();
    const metadataById = new Map(this.channelController.loadMetadata(channelId).items.map((item) => [item.id, item]));
    const parsedById = this.channelController.readContentFilesById(channelId);

    for (const parsed of parsedById.values()) {
      const filePath = parsed.filePath;
      const relativePath = this.relativePathHelper.toRelativePath(filePath);
      const contentId = this.idAllocator.findIdByFile(relativePath);
      let key: string | undefined;
      if (configuredIdField) {
        const bodyFields = ContentParser.parseInlineFrontmatter(parsed.content);
        const bodyValue = bodyFields[configuredIdField]?.trim();
        if (bodyValue && bodyValue.length > 0) {
          key = bodyValue;
        }
      }
      if (!key) {
        const fileName = path.basename(filePath, path.extname(filePath));
        key = fileName.toLowerCase() === 'content'
          ? path.basename(path.dirname(filePath))
          : fileName;
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
    let candidatePath = path.join(contentDir, `${base}.md`);
    let suffix = 1;
    while (fs.existsSync(candidatePath)) {
      candidatePath = path.join(contentDir, `${base}-${suffix}.md`);
      suffix += 1;
    }
    fs.mkdirSync(contentDir, { recursive: true });
    return candidatePath;
  }

  private contentResourcesDirectoryForPath(contentPath: string): string {
    return path.join(path.dirname(contentPath), path.basename(contentPath, path.extname(contentPath)));
  }

  private resolveFetcher(fetchMethod: string): Fetcher {
    const builtinFetcher = getBuiltinFetcher(fetchMethod);
    if (builtinFetcher) {
      return builtinFetcher;
    }

    return createCustomFetcher(path.join(this.customFetchersDirectory, fetchMethod));
  }
}