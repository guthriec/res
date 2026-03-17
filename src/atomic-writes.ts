import * as fs from "fs";
import * as path from "path";

/**
 * Atomically write JSON to a file using temp file + rename.
 * Prevents partial/corrupt files when writes are interrupted.
 */
export async function writeJSONAtomic(
  targetPath: string,
  data: unknown,
  options: { indent?: number } = {},
): Promise<void> {
  const dir = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const random = Math.random().toString(36).slice(2, 10);
  const tempPath = path.join(dir, `.${basename}.tmp.${Date.now()}.${random}`);

  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, options.indent ?? 2), "utf-8");
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Synchronously write JSON to a file using temp file + rename.
 */
export function writeJSONAtomicSync(
  targetPath: string,
  data: unknown,
  options: { indent?: number } = {},
): void {
  const dir = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const random = Math.random().toString(36).slice(2, 10);
  const tempPath = path.join(dir, `.${basename}.tmp.${Date.now()}.${random}`);

  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, options.indent ?? 2), "utf-8");
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}
