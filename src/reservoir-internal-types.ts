export interface ContentLockState {
  id: string;
  locks: string[];
  filePath?: string;
  fetchedAt: string;
  url?: string;
}

export interface ParsedContentFile {
  id: string;
  content: string;
  filePath: string;
}
