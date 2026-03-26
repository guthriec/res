import { ContentItem } from "./types";
import { ChannelControllerImpl } from "./channel-controller";
import { ContentParser } from "./content-parser";
import { RelativePathHelper } from "./relative-path-helper";
import type { ContentController } from "./interfaces";

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

    const results: ContentItem[] = [];

    for (const channel of channels) {
      const parsedById = this.channelController.readContentFilesById(channel.id);
      for (const state of this.channelController.loadMetadata(channel.id).items) {
        const isRetained = state.locks.length > 0;
        if (retained === true && !isRetained) continue;
        if (retained === false && isRetained) continue;
        if (retainedBySet && !state.locks.some((name) => retainedBySet.has(name))) continue;

        const parsed = parsedById.get(state.id);
        if (!parsed) continue;
        const relativePath = this.relativePathHelper.toRelativePath(parsed.filePath);
        results.push({
          id: state.id,
          channelId: channel.id,
          title: ContentParser.inferTitleFromContent(parsed.content),
          fetchedAt: state.fetchedAt,
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

  readContentFrontmatterMap(contentId: string): Record<string, string> {
    const channels = this.channelController.listChannels();
    for (const channel of channels) {
      const exists = this.channelController
        .loadMetadata(channel.id)
        .items.some((item) => item.id === contentId);
      if (!exists) continue;

      const parsed = this.channelController.readContentFilesById(channel.id).get(contentId);
      if (!parsed) {
        throw new Error(`Content file not found for id ${contentId}`);
      }

      return ContentParser.parseInlineFrontmatter(parsed.content);
    }

    throw new Error(`Content not found: ${contentId}`);
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
    const channels = this.channelController.listChannels();

    for (const channel of channels) {
      const state = this.channelController.loadMetadata(channel.id).items.find((item) => item.id === contentId);
      if (!state) continue;

      const parsed = this.channelController.readContentFilesById(channel.id).get(contentId);
      if (!parsed) {
        throw new Error(`Content file not found for id ${contentId}`);
      }

      const updatedContent = ContentParser.writeInlineFrontmatter(parsed.content, updates);
      this.channelController.writeContentById(channel.id, contentId, updatedContent);

      return {
        id: contentId,
        channelId: channel.id,
        title: ContentParser.inferTitleFromContent(updatedContent),
        fetchedAt: state.fetchedAt,
        locks: [...state.locks],
        content: updatedContent,
        filePath: this.relativePathHelper.toRelativePath(parsed.filePath),
      };
    }

    throw new Error(`Content not found: ${contentId}`);
  }
}
