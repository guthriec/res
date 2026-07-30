import * as fs from "fs";

export interface DirectoryWatcherOptions {
  /**
   * Debounce interval in milliseconds. Defaults to 250.
   * Multiple rapid filesystem events within this window trigger a single call
   * to the callback.
   */
  debounceMs?: number;
}

/**
 * Watch a directory recursively and invoke `onChange` (debounced) whenever a
 * filesystem event occurs within `dir`.
 *
 * Gracefully handles:
 * - Directory does not exist → returns a no-op cleanup.
 * - Filesystem does not support `fs.watch` with `recursive: true`
 *   (e.g. some network mounts, FUSE filesystems) → returns a no-op cleanup.
 *
 * The returned cleanup function is idempotent (safe to call more than once).
 */
export function createDirectoryWatcher(
  dir: string,
  onChange: () => void,
  options?: DirectoryWatcherOptions,
): () => void {
  let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;

  const debounceMs = options?.debounceMs ?? 250;

  const scheduleCallback = (): void => {
    if (pendingTimeout !== undefined) {
      clearTimeout(pendingTimeout);
    }
    pendingTimeout = setTimeout(() => {
      pendingTimeout = undefined;
      onChange();
    }, debounceMs);
  };

  if (!fs.existsSync(dir)) {
    return () => {};
  }

  try {
    watcher = fs.watch(dir, { recursive: true }, () => {
      scheduleCallback();
    });
  } catch {
    watcher = undefined;
  }

  return () => {
    if (pendingTimeout !== undefined) {
      clearTimeout(pendingTimeout);
      pendingTimeout = undefined;
    }
    if (watcher !== undefined) {
      watcher.close();
      watcher = undefined;
    }
  };
}
