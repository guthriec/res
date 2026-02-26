function parseFetchArgPair(fetchArg: string): { key: string; value: string } {
  const normalized = fetchArg.trim();
  const separatorIndex = normalized.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error(`Invalid fetch argument: ${fetchArg}. Expected key=value.`);
  }

  const key = normalized.slice(0, separatorIndex).trim();
  const value = normalized.slice(separatorIndex + 1).trim();
  if (!key) {
    throw new Error(`Invalid fetch argument: ${fetchArg}. Expected key=value.`);
  }

  return { key, value };
}

function parseFetchArgObject(fetchArgs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawFetchArg of fetchArgs) {
    if (typeof rawFetchArg !== 'string') continue;
    const trimmed = rawFetchArg.trim();
    if (!trimmed) continue;
    const { key, value } = parseFetchArgPair(trimmed);
    out[key] = value;
  }
  return out;
}

function normalizeStoredFetchArgs(fetchArgs: Record<string, string> | undefined): Record<string, string> {
  if (!fetchArgs || typeof fetchArgs !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(fetchArgs)) {
    if (typeof rawValue !== 'string') {
      continue;
    }
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    out[key] = rawValue.trim();
  }
  return out;
}

export function normalizeFetchArgObject(fetchArgs?: string[]): Record<string, string> | undefined {
  if (!Array.isArray(fetchArgs)) return undefined;
  return parseFetchArgObject(fetchArgs);
}

export function mergeFetchArgObject(
  existingFetchArgs: Record<string, string> | undefined,
  fetchArgEdits: string[] = [],
): Record<string, string> {
  const merged = normalizeStoredFetchArgs(existingFetchArgs);
  const edits = parseFetchArgObject(fetchArgEdits);
  for (const [key, value] of Object.entries(edits)) {
    if (value.length === 0) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export function getFetchArgValue(fetchArgs: Record<string, string> | undefined, key: string): string | undefined {
  if (!fetchArgs || typeof fetchArgs !== 'object') return undefined;
  return fetchArgs[key];
}

export function fetchArgObjectToCliArgs(fetchArgs: Record<string, string> | undefined): string[] {
  if (!fetchArgs || typeof fetchArgs !== 'object') return [];
  return Object.entries(fetchArgs).map(([key, value]) => `${key}=${value}`);
}