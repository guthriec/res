import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { VersionStore, type ContentVersion, type VersionSidecar } from "../src/version-store";

describe("VersionStore", () => {
  let tmpDir: string;
  let store: VersionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "version-store-test-"));
    store = new VersionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hashFile", () => {
    it("returns SHA-256 hex digest for a file", () => {
      const filePath = path.join(tmpDir, "test.md");
      fs.writeFileSync(filePath, "hello world");
      const expected = createHash("sha256").update("hello world").digest("hex");
      expect(VersionStore.hashFile(filePath)).toBe(expected);
    });

    it("returns null for a missing file", () => {
      expect(VersionStore.hashFile("/nonexistent")).toBeNull();
    });

    it("hashes the full file including frontmatter", () => {
      const content = "---\ntitle: Test\n---\n\nBody text";
      const filePath = path.join(tmpDir, "test.md");
      fs.writeFileSync(filePath, content);
      const expected = createHash("sha256").update(content).digest("hex");
      expect(VersionStore.hashFile(filePath)).toBe(expected);
    });
  });

  describe("sidecarPath", () => {
    it("appends .res-version.json to the path", () => {
      expect(VersionStore.sidecarPath("/a/b/foo.md")).toBe("/a/b/foo.md.res-version.json");
    });
  });

  describe("read", () => {
    it("returns null when no sidecar exists", () => {
      const mdPath = path.join(tmpDir, "test.md");
      fs.writeFileSync(mdPath, "hello");
      expect(store.read(mdPath)).toBeNull();
    });

    it("returns parsed sidecar when it exists", () => {
      const mdPath = path.join(tmpDir, "test.md");
      fs.writeFileSync(mdPath, "hello");
      const sidecar: VersionSidecar = {
        contentId: "42",
        chain: [{ id: "v1", parentIds: [], hash: "abc", timestamp: new Date().toISOString() }],
      };
      fs.writeFileSync(VersionStore.sidecarPath(mdPath), JSON.stringify(sidecar));

      const read = store.read(mdPath);
      expect(read).not.toBeNull();
      expect(read!.contentId).toBe("42");
      expect(read!.chain).toHaveLength(1);
      expect(read!.chain[0].id).toBe("v1");
    });

    it("returns null for corrupt sidecar JSON", () => {
      const mdPath = path.join(tmpDir, "test.md");
      fs.writeFileSync(mdPath, "hello");
      fs.writeFileSync(VersionStore.sidecarPath(mdPath), "not-json");

      expect(store.read(mdPath)).toBeNull();
    });
  });

  describe("write", () => {
    it("creates a sidecar file", async () => {
      const mdPath = path.join(tmpDir, "test.md");
      fs.writeFileSync(mdPath, "hello");
      const sidecar: VersionSidecar = {
        contentId: "1",
        chain: [{ id: "v1", parentIds: [], hash: "abc", timestamp: new Date().toISOString() }],
      };

      await store.write(mdPath, sidecar);

      const scPath = VersionStore.sidecarPath(mdPath);
      expect(fs.existsSync(scPath)).toBe(true);
      const read = JSON.parse(fs.readFileSync(scPath, "utf-8"));
      expect(read.contentId).toBe("1");
      expect(read.chain).toHaveLength(1);
    });

    it("overwrites existing sidecar atomically", async () => {
      const mdPath = path.join(tmpDir, "test.md");
      fs.writeFileSync(mdPath, "hello");
      const v1: VersionSidecar = {
        contentId: "1",
        chain: [{ id: "v1", parentIds: [], hash: "abc", timestamp: new Date().toISOString() }],
      };
      const v2: VersionSidecar = {
        contentId: "1",
        chain: [
          { id: "v1", parentIds: [], hash: "abc", timestamp: new Date().toISOString() },
          { id: "v2", parentIds: ["v1"], hash: "def", timestamp: new Date().toISOString() },
        ],
      };

      await store.write(mdPath, v1);
      await store.write(mdPath, v2);

      const read = store.read(mdPath);
      expect(read!.chain).toHaveLength(2);
    });
  });

  describe("isTombstoned", () => {
    it("returns false when no sidecar exists", () => {
      expect(store.isTombstoned(path.join(tmpDir, "test.md"))).toBe(false);
    });

    it("returns false when tip hash is not null", () => {
      const mdPath = path.join(tmpDir, "test.md");
      fs.writeFileSync(mdPath, "hello");
      const sidecar: VersionSidecar = {
        contentId: "1",
        chain: [{ id: "v1", parentIds: [], hash: "abc", timestamp: new Date().toISOString() }],
      };
      fs.writeFileSync(VersionStore.sidecarPath(mdPath), JSON.stringify(sidecar));

      expect(store.isTombstoned(mdPath)).toBe(false);
    });

    it("returns true when tip hash is null", () => {
      const mdPath = path.join(tmpDir, "test.md");
      fs.writeFileSync(mdPath, "hello");
      const sidecar: VersionSidecar = {
        contentId: "1",
        chain: [
          { id: "v1", parentIds: [], hash: "abc", timestamp: new Date().toISOString() },
          { id: "v2", parentIds: ["v1"], hash: null, timestamp: new Date().toISOString() },
        ],
      };
      fs.writeFileSync(VersionStore.sidecarPath(mdPath), JSON.stringify(sidecar));

      expect(store.isTombstoned(mdPath)).toBe(true);
    });
  });

  describe("findLCA", () => {
    function v(id: string, parentIds: string[]): ContentVersion {
      return { id, parentIds, hash: "abc", timestamp: new Date().toISOString() };
    }

    it("returns the common version when chains overlap", () => {
      const local = [v("v1", []), v("v2", ["v1"]), v("v3", ["v2"])];
      const remote = [v("v1", []), v("v2a", ["v1"]), v("v3a", ["v2a"])];

      const lca = VersionStore.prototype.findLCA(local, remote);
      expect(lca).not.toBeNull();
      expect(lca!.id).toBe("v1");
    });

    it("returns null when chains don't overlap", () => {
      const local = [v("a", []), v("b", ["a"])];
      const remote = [v("c", []), v("d", ["c"])];

      expect(VersionStore.prototype.findLCA(local, remote)).toBeNull();
    });

    it("returns null when either chain is empty", () => {
      expect(VersionStore.prototype.findLCA([], [v("v1", [])])).toBeNull();
      expect(VersionStore.prototype.findLCA([v("v1", [])], [])).toBeNull();
    });

    it("identifies the latest common ancestor, not just any overlap", () => {
      const local = [v("v1", []), v("v2", ["v1"]), v("v3", ["v2"])];
      const remote = [v("v1", []), v("v2", ["v1"]), v("v3r", ["v2"])];

      const lca = VersionStore.prototype.findLCA(local, remote);
      expect(lca!.id).toBe("v2");
    });

    it("finds LCA with merge commit containing multiple parents", () => {
      const local = [v("v1", []), v("v2", ["v1"]), v("v3", ["v2"])];
      const remote = [v("v1", []), v("v2r", ["v1"]), v("v3", ["v2", "v2r"])];

      const lca = VersionStore.prototype.findLCA(local, remote);
      expect(lca!.id).toBe("v3");
    });
  });
});
