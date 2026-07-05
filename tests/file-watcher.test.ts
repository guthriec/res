import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createDirectoryWatcher } from "../src/file-watcher";

describe("createDirectoryWatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-watcher-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls onChange when a file is created", async () => {
    const onChange = vi.fn();
    const cleanup = createDirectoryWatcher(tmpDir, onChange, { debounceMs: 50 });

    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(tmpDir, "test.md"), "hello");
    await new Promise((r) => setTimeout(r, 200));

    expect(onChange).toHaveBeenCalled();
    cleanup();
  });

  it("calls onChange when a file is modified", async () => {
    const filePath = path.join(tmpDir, "test.md");
    fs.writeFileSync(filePath, "hello");
    const onChange = vi.fn();

    const cleanup = createDirectoryWatcher(tmpDir, onChange, { debounceMs: 50 });
    await new Promise((r) => setTimeout(r, 20));

    fs.writeFileSync(filePath, "world");
    await new Promise((r) => setTimeout(r, 200));

    expect(onChange).toHaveBeenCalled();
    cleanup();
  });

  it("returns a no-op cleanup when directory does not exist", () => {
    const cleanup = createDirectoryWatcher("/nonexistent", vi.fn());
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
  });

  it("cleanup prevents further callbacks", async () => {
    const onChange = vi.fn();
    const cleanup = createDirectoryWatcher(tmpDir, onChange, { debounceMs: 50 });

    await new Promise((r) => setTimeout(r, 20));
    cleanup();

    fs.writeFileSync(path.join(tmpDir, "test.md"), "hello");
    await new Promise((r) => setTimeout(r, 200));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("debounces multiple rapid changes into a single callback", async () => {
    const onChange = vi.fn();
    const debounceMs = 80;
    const cleanup = createDirectoryWatcher(tmpDir, onChange, { debounceMs });

    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(tmpDir, "a.md"), "a");
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(tmpDir, "b.md"), "b");
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(tmpDir, "c.md"), "c");

    await new Promise((r) => setTimeout(r, debounceMs + 100));
    expect(onChange).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("fires again after debounce window resets", async () => {
    const onChange = vi.fn();
    const debounceMs = 50;
    const cleanup = createDirectoryWatcher(tmpDir, onChange, { debounceMs });

    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(tmpDir, "a.md"), "a");
    await new Promise((r) => setTimeout(r, debounceMs + 50));
    onChange.mockClear();

    fs.writeFileSync(path.join(tmpDir, "b.md"), "b");
    await new Promise((r) => setTimeout(r, debounceMs + 50));

    expect(onChange).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("can be cleaned up multiple times without error", () => {
    const cleanup = createDirectoryWatcher(tmpDir, vi.fn(), { debounceMs: 50 });
    cleanup();
    cleanup();
  });
});
