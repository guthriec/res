import * as fs from 'fs';
import * as path from 'path';

const COUNTER_FILE = '.res-content-id.counter';
const MAP_FILE = '.res-content-id.map.json';
const LOCK_FILE = '.res-content-id.lock';
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ContentIdAllocator {
  private static readonly byReservoirDir = new Map<string, ContentIdAllocator>();

  static forReservoir(reservoirDir: string): ContentIdAllocator {
    const dir = path.resolve(reservoirDir);
    const existing = ContentIdAllocator.byReservoirDir.get(dir);
    if (existing) return existing;
    const created = new ContentIdAllocator(dir);
    ContentIdAllocator.byReservoirDir.set(dir, created);
    return created;
  }

  private readonly reservoirDir: string;
  private readonly counterPath: string;
  private readonly mapPath: string;
  private readonly lockPath: string;

  private constructor(reservoirDir: string) {
    this.reservoirDir = reservoirDir;
    this.counterPath = path.join(this.reservoirDir, COUNTER_FILE);
    this.mapPath = path.join(this.reservoirDir, MAP_FILE);
    this.lockPath = path.join(this.reservoirDir, LOCK_FILE);
  }

  async nextId(): Promise<string> {
    return this.withLock(() => {
      const current = this.readCurrentValue();
      const next = current + 1;
      fs.writeFileSync(this.counterPath, `${next}\n`, 'utf-8');
      return String(next);
    });
  }

  async assignIdToFile(relativeFilePath: string): Promise<string> {
    const normalizedPath = this.normalizeRelativePath(relativeFilePath);
    return this.withLock(() => {
      const mapping = this.readMapValue();
      const existing = this.findIdByFileInMap(mapping, normalizedPath);
      if (existing) {
        return existing;
      }

      const current = this.readCurrentValue();
      const next = current + 1;
      const nextId = String(next);
      mapping[nextId] = normalizedPath;
      fs.writeFileSync(this.counterPath, `${next}\n`, 'utf-8');
      this.writeMapValue(mapping);
      return nextId;
    });
  }

  async setMapping(id: string, relativeFilePath: string): Promise<void> {
    const normalizedPath = this.normalizeRelativePath(relativeFilePath);
    await this.withLock(() => {
      const mapping = this.readMapValue();
      mapping[id] = normalizedPath;
      this.writeMapValue(mapping);
      this.bumpCounterIfNeeded(id);
    });
  }

  async removeMappingById(id: string): Promise<void> {
    await this.withLock(() => {
      const mapping = this.readMapValue();
      if (mapping[id] === undefined) return;
      delete mapping[id];
      this.writeMapValue(mapping);
    });
  }

  getFileForId(id: string): string | undefined {
    return this.readMapValue()[id];
  }

  findIdByFile(relativeFilePath: string): string | undefined {
    const normalizedPath = this.normalizeRelativePath(relativeFilePath);
    return this.findIdByFileInMap(this.readMapValue(), normalizedPath);
  }

  listMappings(): Record<string, string> {
    return this.readMapValue();
  }

  private readCurrentValue(): number {
    if (!fs.existsSync(this.counterPath)) return 0;
    const raw = fs.readFileSync(this.counterPath, 'utf-8').trim();
    if (raw.length === 0) return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  }

  private readMapValue(): Record<string, string> {
    if (!fs.existsSync(this.mapPath)) return {};
    try {
      const raw = fs.readFileSync(this.mapPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      const normalized: Record<string, string> = {};
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') continue;
        normalized[id] = this.normalizeRelativePath(value);
      }
      return normalized;
    } catch {
      return {};
    }
  }

  private writeMapValue(mapping: Record<string, string>): void {
    fs.writeFileSync(this.mapPath, `${JSON.stringify(mapping, null, 2)}\n`, 'utf-8');
  }

  private findIdByFileInMap(mapping: Record<string, string>, normalizedPath: string): string | undefined {
    for (const [id, mappedPath] of Object.entries(mapping)) {
      if (mappedPath === normalizedPath) {
        return id;
      }
    }
    return undefined;
  }

  private normalizeRelativePath(relativeFilePath: string): string {
    return relativeFilePath
      .trim()
      .replace(/\\/g, '/');
  }

  private bumpCounterIfNeeded(id: string): void {
    const parsedId = Number.parseInt(id, 10);
    if (!Number.isFinite(parsedId) || parsedId <= 0) return;
    const current = this.readCurrentValue();
    if (parsedId > current) {
      fs.writeFileSync(this.counterPath, `${parsedId}\n`, 'utf-8');
    }
  }

  private async withLock<T>(action: () => T): Promise<T> {
    const release = await this.acquireLock();
    try {
      return action();
    } finally {
      release();
    }
  }

  private async acquireLock(): Promise<() => void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        return () => {
          try {
            fs.closeSync(fd);
          } finally {
            if (fs.existsSync(this.lockPath)) {
              fs.unlinkSync(this.lockPath);
            }
          }
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring content ID lock at ${this.lockPath}`);
        }
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }
  }
}