import * as fs from 'fs';
import * as path from 'path';
import { ChannelController } from './channel-controller';

const RES_METADATA_DIR = '.res';

export class EvictionController {
  constructor(
    private readonly directory: string,
    private readonly getMaxSizeMB: () => number | undefined,
    private readonly channelController: ChannelController,
  ) {}

  clean(): void {
    const maxSizeMB = this.getMaxSizeMB();
    if (!maxSizeMB) return;
    const maxBytes = maxSizeMB * 1024 * 1024;
    const contentEntries = fs
      .readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.name !== RES_METADATA_DIR)
      .map((entry) => path.join(this.directory, entry.name));
    const currentSize = contentEntries.reduce((total, entryPath) => total + this.getDirSize(entryPath), 0);
    if (currentSize <= maxBytes) return;

    type Candidate = {
      id: string;
      channelId: string;
      fetchedAt: string;
      locks: string[];
      filePath: string;
    };
    const candidates: Candidate[] = [];

    for (const channel of this.channelController.listChannels()) {
      const parsedById = this.channelController.readContentFilesById(channel.id);
      for (const item of this.channelController.loadMetadata(channel.id).items) {
        const parsed = parsedById.get(item.id);
        if (!parsed) continue;
        if (item.locks.length === 0) {
          candidates.push({
            id: item.id,
            channelId: channel.id,
            fetchedAt: item.fetchedAt,
            locks: item.locks,
            filePath: parsed.filePath,
          });
        }
      }
    }

    candidates.sort((a, b) => new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime());

    let totalSize = currentSize;
    for (const candidate of candidates) {
      if (totalSize <= maxBytes) break;
      if (fs.existsSync(candidate.filePath)) {
        totalSize -= fs.statSync(candidate.filePath).size;
        fs.unlinkSync(candidate.filePath);
        this.channelController.removeFromMetadata(candidate.channelId, candidate.id);
      }
    }
  }

  private getDirSize(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    const stat = fs.statSync(dir);
    if (stat.isFile()) return stat.size;
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((acc, entry) => {
      const p = path.join(dir, entry.name);
      return acc + (entry.isDirectory() ? this.getDirSize(p) : fs.statSync(p).size);
    }, 0);
  }
}
