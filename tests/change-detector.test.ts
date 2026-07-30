import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChangeDetector } from "../src/change-detector";
import { VersionStore, type VersionSidecar } from "../src/version-store";

describe("ChangeDetector", () => {
  let tmpDir: string;
  let detector: ChangeDetector;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "change-detector-test-"));
    detector = new ChangeDetector(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeMd(relPath: string, content: string): string {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
    return absPath;
  }

  function readSidecar(mdPath: string): VersionSidecar | null {
    const store = new VersionStore(tmpDir);
    return store.read(mdPath);
  }

  describe("scanAll", () => {
    it("creates an initial sidecar for a new .md file", async () => {
      const mdPath = writeMd("channel-a/hello.md", "Hello, world!\n");

      await detector.scanAll();

      const sidecar = readSidecar(mdPath);
      expect(sidecar).not.toBeNull();
      expect(sidecar!.contentId).toBe("1");
      expect(sidecar!.chain).toHaveLength(1);
      expect(sidecar!.chain[0].id).toBe("v1");
      expect(sidecar!.chain[0].parentIds).toEqual([]);
      expect(sidecar!.chain[0].hash).not.toBeNull();
    });

    it("records a new version when file content changes", async () => {
      const mdPath = writeMd("channel-a/hello.md", "Hello, world!\n");
      await detector.scanAll();

      // Modify the file
      fs.writeFileSync(mdPath, "Goodbye, world!\n");

      await detector.scanAll();

      const sidecar = readSidecar(mdPath);
      expect(sidecar!.chain).toHaveLength(2);
      expect(sidecar!.chain[1].id).toBe("v2");
      expect(sidecar!.chain[1].parentIds).toEqual([sidecar!.chain[0].id]);
      expect(sidecar!.chain[1].hash).not.toBe(sidecar!.chain[0].hash);
    });

    it("records a tombstone when a file is deleted", async () => {
      const mdPath = writeMd("channel-a/hello.md", "Hello");
      await detector.scanAll();

      fs.unlinkSync(mdPath);
      await detector.scanAll();

      const sidecar = readSidecar(mdPath);
      expect(sidecar!.chain).toHaveLength(2);
      expect(sidecar!.chain[1].hash).toBeNull();
    });

    it("does nothing when file has not changed", async () => {
      const mdPath = writeMd("channel-a/hello.md", "Hello");
      await detector.scanAll();

      await detector.scanAll();

      const sidecar = readSidecar(mdPath);
      expect(sidecar!.chain).toHaveLength(1);
    });

    it("does nothing when file is already tombstoned", async () => {
      const mdPath = writeMd("channel-a/hello.md", "Hello");
      await detector.scanAll();

      fs.unlinkSync(mdPath);
      await detector.scanAll(); // first tombstone

      const sidecar1 = readSidecar(mdPath);
      expect(sidecar1!.chain).toHaveLength(2);

      await detector.scanAll(); // second pass — should be no-op

      const sidecar2 = readSidecar(mdPath);
      expect(sidecar2!.chain).toHaveLength(2); // unchanged
    });

    it("handles multiple files across multiple channels", async () => {
      const md1 = writeMd("channel-a/a.md", "A content\n");
      const md2 = writeMd("channel-b/b.md", "B content\n");
      const md3 = writeMd("channel-c/c.md", "C content\n");

      await detector.scanAll();

      expect(readSidecar(md1)).not.toBeNull();
      expect(readSidecar(md2)).not.toBeNull();
      expect(readSidecar(md3)).not.toBeNull();
    });

    it("skips files in .res/ directory", async () => {
      const resPath = writeMd(".res/some-file.md", "metadata");
      await detector.scanAll();

      expect(readSidecar(resPath)).toBeNull();
    });

    it("does not create sidecars for .res-version.json files themselves", async () => {
      // A file that ends with .res-version.json should not be treated as a .md file
      const fakeSidecar = writeMd("channel-a/foo.res-version.json", '{"contentId":"1","chain":[]}');
      await detector.scanAll();

      const mdPath = path.join(tmpDir, "channel-a", "foo.res-version.json");
      // mdPath is not .md, so it won't be scanned as content. But the .res-version.json
      // extension filtering is done in collectMdFiles, so this should be fine.
      // Verify no sidecar was created for this file.
      expect(fs.existsSync(VersionStore.sidecarPath(mdPath))).toBe(false);
    });
  });

  describe("startWatching", () => {
    it("returns a cleanup function", () => {
      const cleanup = detector.startWatching();
      expect(typeof cleanup).toBe("function");
      cleanup();
    });

    it("cleanup is idempotent", () => {
      const cleanup = detector.startWatching();
      cleanup();
      cleanup(); // should not throw
    });

    it("subsequent calls return existing cleanup", () => {
      const cleanup1 = detector.startWatching();
      const cleanup2 = detector.startWatching();
      expect(cleanup1).toBe(cleanup2);
      cleanup1();
    });
  });
});
