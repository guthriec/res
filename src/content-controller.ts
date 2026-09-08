import { ContentItem } from "./types";
import { ChannelControllerImpl } from "./channel-controller";
import { ContentParser } from "./content-parser";
import { RelativePathHelper } from "./relative-path-helper";
import type { ContentController } from "./interfaces";
import type { ContentLockState, ParsedContentFile } from "./reservoir-internal-types";
import { ReservoirError, ErrorCodes } from "./errors";

export class ContentControllerImpl implements ContentController {
  private readonly relativePathHelper: RelativePathHelper;

  constructor(
    private readonly channelController: ChannelControllerImpl,
    reservoirDir: string,
  ) {
    this.relativePathHelper = new RelativePathHelper(reservoirDir);
  }

  listContent(
    options: {
      channelIds?: string[];
      retained?: boolean;
      retainedBy?: string[];
      pageSize?: number;
      pageOffset?: number;
    } = {},
  ): ContentItem[] {
    const channels = options.channelIds
      ? options.channelIds.map((id) => this.channelController.viewChannel(id))
      : this.channelController.listChannels();
    const retained = options.retained;
    const normalizedRetainedBy = options.retainedBy
      ?.map((name) => name.trim())
      .filter((name) => name.length > 0);
    const retainedBySet =
      normalizedRetainedBy && normalizedRetainedBy.length > 0
        ? new Set(normalizedRetainedBy)
        : undefined;
    const pageOffset = options.pageOffset ?? 0;
    const pageSize = options.pageSize;
    const hasLockFilter = retained !== undefined || retainedBySet !== undefined;

    const results: ContentItem[] = [];
    const candidates: Array<{ channelId: string; state: ContentLockState }> = [];

    for (const channel of channels) {
      const metadata = this.channelController.loadMetadata(channel.id);

      if (!hasLockFilter) {
        const parsedById = this.channelController.readContentFilesById(channel.id);
        for (const state of metadata.items) {
          const parsed = parsedById.get(state.id);
          if (!parsed) continue;
          results.push(this.buildContentItem(channel.id, state, parsed));
        }
        continue;
      }

      for (const state of metadata.items) {
        const isRetained = state.locks.length > 0;
        if (retained === true && !isRetained) continue;
        if (retained === false && isRetained) continue;
        if (retainedBySet && !state.locks.some((name) => retainedBySet.has(name))) continue;
        candidates.push({ channelId: channel.id, state });
      }
    }

    if (!hasLockFilter) {
      if (pageSize === undefined) {
        return results.slice(pageOffset);
      }
      return results.slice(pageOffset, pageOffset + pageSize);
    }

    const page =
      pageSize === undefined
        ? candidates.slice(pageOffset)
        : candidates.slice(pageOffset, pageOffset + pageSize);

    for (const { channelId, state } of page) {
      const parsed = this.channelController.readContentFileById(channelId, state.id);
      if (!parsed) continue;
      results.push(this.buildContentItem(channelId, state, parsed));
    }

    return results;
  }

  getContentById(channelId: string, contentId: string): ContentItem | null {
    const parsed = this.channelController.readContentFileById(channelId, contentId);
    if (!parsed) return null;

    const state = this.channelController
      .loadMetadata(channelId)
      .items.find((item) => item.id === contentId);
    if (!state) return null;

    return this.buildContentItem(channelId, state, parsed);
  }

  private buildContentItem(
    channelId: string,
    state: ContentLockState,
    parsed: ParsedContentFile,
  ): ContentItem {
    return {
      id: state.id,
      channelId,
      title: ContentParser.inferTitleFromContent(parsed.content),
      fetchedAt: state.fetchedAt,
      locks: [...state.locks],
      content: parsed.content,
      filePath: this.relativePathHelper.toRelativePath(parsed.filePath),
    };
  }

  listRetained(channelIds?: string[]): ContentItem[] {
    return this.listContent({ channelIds, retained: true });
  }

  readContentFrontmatterMap(contentId: string): Record<string, string> {
    const channels = this.channelController.listChannels();
    for (const channel of channels) {
      const exists = this.channelController
        .loadMetadata(channel.id)
        .items.some((item) => item.id === contentId);
      if (!exists) continue;

      const parsed = this.channelController.readContentFilesById(channel.id).get(contentId);
      if (!parsed) {
        throw new ReservoirError(ErrorCodes.CONTENT_FILE_NOT_FOUND, `Content file not found for id ${contentId}`);
      }

      return ContentParser.parseInlineFrontmatter(parsed.content);
    }

    throw new ReservoirError(ErrorCodes.CONTENT_NOT_FOUND, `Content not found: ${contentId}`);
  }

  readContentFrontmatter(contentId: string, key: string): string | undefined {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new ReservoirError(ErrorCodes.INVALID_INPUT, "Frontmatter key must not be empty");
    }
    const fields = this.readContentFrontmatterMap(contentId);
    return fields[normalizedKey];
  }

  async writeContentFrontmatter(
    contentId: string,
    updates: Record<string, string | null>,
  ): Promise<ContentItem> {
    const channels = this.channelController.listChannels();

    for (const channel of channels) {
      const state = this.channelController
        .loadMetadata(channel.id)
        .items.find((item) => item.id === contentId);
      if (!state) continue;

      const parsed = this.channelController.readContentFileById(channel.id, contentId);
      if (!parsed) {
        throw new ReservoirError(ErrorCodes.CONTENT_FILE_NOT_FOUND, `Content file not found for id ${contentId}`);
      }

      const updatedContent = ContentParser.writeInlineFrontmatter(parsed.content, updates);
      this.channelController.writeContentById(channel.id, contentId, updatedContent);

      return this.buildContentItem(channel.id, state, {
        id: contentId,
        content: updatedContent,
        filePath: parsed.filePath,
      });
    }

    throw new ReservoirError(ErrorCodes.CONTENT_NOT_FOUND, `Content not found: ${contentId}`);
  }
}
