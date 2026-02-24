import * as fs from 'fs';
import * as path from 'path';

const COUNTER_FILE = '.res-content-id.counter';
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
  private readonly lockPath: string;

  private constructor(reservoirDir: string) {
    this.reservoirDir = reservoirDir;
    this.counterPath = path.join(this.reservoirDir, COUNTER_FILE);
    this.lockPath = path.join(this.reservoirDir, LOCK_FILE);
  }

  async nextId(): Promise<string> {
    const release = await this.acquireLock();
    try {
      const current = this.readCurrentValue();
      const next = current + 1;
      fs.writeFileSync(this.counterPath, `${next}\n`, 'utf-8');
      return String(next);
    } finally {
      release();
    }
  }

  private readCurrentValue(): number {
    if (!fs.existsSync(this.counterPath)) return 0;
    const raw = fs.readFileSync(this.counterPath, 'utf-8').trim();
    if (raw.length === 0) return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
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