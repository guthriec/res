import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { FetchedContent } from '../types';
import { fetchArgObjectToCliArgs } from '../fetch-args';

const execFileAsync = promisify(execFile);

interface DiscoveredItem {
  markdownPath: string;
  sourceFileName: string;
}

function listMarkdownItems(outsDir: string): DiscoveredItem[] {
  if (!fs.existsSync(outsDir)) return [];
  return fs
    .readdirSync(outsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => ({
      markdownPath: path.join(outsDir, entry.name),
      sourceFileName: entry.name,
    }));
}

function collectSupplementaryFiles(resourcesRoot: string): Array<{ relativePath: string; content: Buffer }> {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  const stack: string[] = [''];

  while (stack.length > 0) {
    const relativeDir = stack.pop()!;
    const absoluteDir = path.join(resourcesRoot, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.join(relativeDir, entry.name);
      const absolutePath = path.join(resourcesRoot, relativePath);
      if (entry.isDirectory()) {
        stack.push(relativePath);
        continue;
      }
      if (entry.isFile()) {
        files.push({
          relativePath,
          content: fs.readFileSync(absolutePath),
        });
      }
    }
  }

  return files;
}

export async function fetchCustom(
  executablePath: string,
  channelId: string,
  fetchArgs: Record<string, string> | undefined,
): Promise<FetchedContent[]> {
  const executableAbsolutePath = path.resolve(executablePath);
  if (!fs.existsSync(executableAbsolutePath)) {
    throw new Error(`Custom fetcher not found: ${executableAbsolutePath}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-fetch-custom-'));
  const outsDir = path.join(tempDir, 'outs');
  fs.mkdirSync(outsDir, { recursive: true });

  try {
    await execFileAsync(executableAbsolutePath, fetchArgObjectToCliArgs(fetchArgs), {
      cwd: tempDir,
      env: {
        ...process.env,
        RES_CHANNEL_ID: channelId,
      },
    });

    const items = listMarkdownItems(outsDir).map((entry) => {
      const content = fs.readFileSync(entry.markdownPath, 'utf-8');
      const title = path.basename(entry.sourceFileName, '.md') || '(untitled)';
      const resourceDir = path.join(outsDir, title);

      return {
        title,
        content,
        sourceFileName: entry.sourceFileName,
        supplementaryFiles: fs.existsSync(resourceDir) ? collectSupplementaryFiles(resourceDir) : [],
      };
    });

    return items;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
