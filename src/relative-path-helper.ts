import * as path from 'path';

export class RelativePathHelper {
  constructor(private readonly baseDir: string) {}

  static normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/');
  }

  toRelativePath(filePath: string): string {
    return RelativePathHelper.normalizeRelativePath(path.relative(this.baseDir, filePath));
  }
}