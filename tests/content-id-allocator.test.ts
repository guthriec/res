import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContentIdAllocator } from '../src/content-id-allocator';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-id-alloc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ContentIdAllocator', () => {
  it('starts from 1 and increments serially', async () => {
    const allocator = ContentIdAllocator.forReservoir(tmpDir);

    const id1 = await allocator.nextId();
    const id2 = await allocator.nextId();
    const id3 = await allocator.nextId();

    expect(id1).toBe('1');
    expect(id2).toBe('2');
    expect(id3).toBe('3');
  });

  it('prevents collisions for concurrent requests', async () => {
    const allocator = ContentIdAllocator.forReservoir(tmpDir);

    const ids = await Promise.all(Array.from({ length: 25 }, () => allocator.nextId()));

    expect(new Set(ids).size).toBe(25);
    expect(ids.map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('tracks IDs as a map from global id to relative filename', async () => {
    const allocator = ContentIdAllocator.forReservoir(tmpDir);

    const id = await allocator.assignIdToFile('channels/ch-a/content/item.md');
    expect(id).toBe('1');
    expect(allocator.getFileForId(id)).toBe('channels/ch-a/content/item.md');

    await allocator.setMapping(id, 'channels/ch-a/content/item-renamed.md');
    expect(allocator.getFileForId(id)).toBe('channels/ch-a/content/item-renamed.md');

    await allocator.removeMappingById(id);
    expect(allocator.getFileForId(id)).toBeUndefined();
  });
});