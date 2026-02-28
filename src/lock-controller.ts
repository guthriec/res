import * as fs from 'fs';
import * as path from 'path';
import { Channel } from './types';
import { InputNormalizer } from './input-normalizer';
import { ChannelController } from './channel-controller';

const CHANNEL_CONFIG_FILE = 'channel.json';

export class LockController {
  constructor(private readonly channelController: ChannelController) {}

  retainContent(contentId: string, lockName?: string): void {
    this.updateContentLock(contentId, InputNormalizer.lockName(lockName), true);
  }

  releaseContent(contentId: string, lockName?: string): void {
    this.updateContentLock(contentId, InputNormalizer.lockName(lockName), false);
  }

  retainContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): number {
    return this.updateContentLockRange({ ...options, retain: true });
  }

  releaseContentRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
  }): number {
    return this.updateContentLockRange({ ...options, retain: false });
  }

  retainChannel(channelId: string, lockName?: string): Channel {
    const channel = this.channelController.viewChannel(channelId);
    const normalized = InputNormalizer.lockName(lockName);
    const retainedLocks = InputNormalizer.locks([...channel.retainedLocks, normalized]);
    const updated: Channel = { ...channel, retainedLocks };
    fs.writeFileSync(
      path.join(this.channelController.resolveChannelDir(channelId), CHANNEL_CONFIG_FILE),
      JSON.stringify(updated, null, 2),
    );
    return updated;
  }

  releaseChannel(channelId: string, lockName?: string): Channel {
    const channel = this.channelController.viewChannel(channelId);
    const normalized = InputNormalizer.lockName(lockName);
    const retainedLocks = channel.retainedLocks.filter((name) => name !== normalized);
    const updated: Channel = { ...channel, retainedLocks };
    fs.writeFileSync(
      path.join(this.channelController.resolveChannelDir(channelId), CHANNEL_CONFIG_FILE),
      JSON.stringify(updated, null, 2),
    );
    return updated;
  }

  private findItem(contentId: string): { channelId: string; index: number } | null {
    for (const channel of this.channelController.listChannels()) {
      const meta = this.channelController.loadMetadata(channel.id);
      const idx = meta.items.findIndex((i) => i.id === contentId);
      if (idx !== -1) return { channelId: channel.id, index: idx };
    }
    return null;
  }

  private updateContentLock(contentId: string, lockName: string, retain: boolean): void {
    const found = this.findItem(contentId);
    if (!found) throw new Error(`Content not found: ${contentId}`);
    const meta = this.channelController.loadMetadata(found.channelId);
    const item = meta.items[found.index];
    if (retain) {
      item.locks = InputNormalizer.locks([...item.locks, lockName]);
    } else {
      item.locks = item.locks.filter((name) => name !== lockName);
    }
    this.channelController.saveMetadata(found.channelId, meta);
  }

  private updateContentLockRange(options: {
    fromId?: string;
    toId?: string;
    channelId?: string;
    lockName?: string;
    retain: boolean;
  }): number {
    const { fromId, toId, channelId, lockName, retain } = options;
    const normalized = InputNormalizer.lockName(lockName);
    const channels = channelId
      ? [this.channelController.viewChannel(channelId)]
      : this.channelController.listChannels();

    const fromIdNum = fromId ? Number(fromId) : -Infinity;
    const toIdNum = toId ? Number(toId) : Infinity;

    if (fromId && isNaN(fromIdNum)) throw new Error(`Invalid start ID: ${fromId}`);
    if (toId && isNaN(toIdNum)) throw new Error(`Invalid end ID: ${toId}`);
    if (fromIdNum > toIdNum) throw new Error(`Invalid range: fromId (${fromId}) comes after toId (${toId})`);

    let foundFrom = !fromId;
    let foundTo = !toId;
    let count = 0;
    const metaByChannel = new Map<string, ReturnType<ChannelController['loadMetadata']>>();

    for (const channel of channels) {
      if (!metaByChannel.has(channel.id)) {
        metaByChannel.set(channel.id, this.channelController.loadMetadata(channel.id));
      }
      const meta = metaByChannel.get(channel.id)!;

      for (const item of meta.items) {
        const itemIdNum = Number(item.id);
        if (isNaN(itemIdNum)) continue;

        if (fromId && item.id === fromId) foundFrom = true;
        if (toId && item.id === toId) foundTo = true;

        if (itemIdNum >= fromIdNum && itemIdNum <= toIdNum) {
          if (retain) {
            item.locks = InputNormalizer.locks([...item.locks, normalized]);
          } else {
            item.locks = item.locks.filter((name) => name !== normalized);
          }
          count++;
        }
      }
    }

    if (!foundFrom) throw new Error(`Start ID not found: ${fromId}`);
    if (!foundTo) throw new Error(`End ID not found: ${toId}`);

    for (const [chId, meta] of metaByChannel.entries()) {
      this.channelController.saveMetadata(chId, meta);
    }

    return count;
  }
}
