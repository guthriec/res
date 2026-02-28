import { ContentItem } from './types';
import { ChannelController } from './channel-controller';
import { ContentParser } from './content-parser';
import { RelativePathHelper } from './relative-path-helper';

export class ContentController {
  private readonly relativePathHelper: RelativePathHelper;

  constructor(
    private readonly channelController: ChannelController,
    reservoirDir: string,
  ) {
    this.relativePathHelper = new RelativePathHelper(reservoirDir);
  }

  listContent(options: {
    channelIds?: string[];
    retained?: boolean;
    retainedBy?: string[];
    pageSize?: number;
    pageOffset?: number;
  } = {}): ContentItem[] {
    const channels = options.channelIds
      ? options.channelIds.map((id) => this.channelController.viewChannel(id))
      : this.channelController.listChannels();
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
}
