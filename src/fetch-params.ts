function normalizeStoredFetchParams(fetchParams: Record<string, string> | undefined): Record<string, string> {
  if (!fetchParams || typeof fetchParams !== 'object' || Array.isArray(fetchParams)) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(fetchParams)) {
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

function parseFetchParamPatch(fetchParamPatch?: string): Record<string, string | null> | undefined {
  if (fetchParamPatch === undefined) return undefined;
  const normalizedInput = fetchParamPatch.trim();
  if (normalizedInput.length === 0) {
    throw new Error('Invalid fetch params patch: expected a JSON object string.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedInput);
  } catch {
    throw new Error('Invalid fetch params patch: expected valid JSON object syntax.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid fetch params patch: expected a JSON object.');
  }

  const out: Record<string, string | null> = {};
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    const key = rawKey.trim();
    if (!key) continue;

    if (rawValue === null) {
      out[key] = null;
      continue;
    }

    if (typeof rawValue === 'string') {
      out[key] = rawValue.trim();
      continue;
    }

    out[key] = JSON.stringify(rawValue);
  }

  return out;
}

export function normalizeFetchParamObject(fetchParamPatch?: string): Record<string, string> | undefined {
  const patch = parseFetchParamPatch(fetchParamPatch);
  if (!patch) return undefined;

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) continue;
    normalized[key] = value;
  }

  return normalized;
}

export function mergeFetchParamObject(
  existingFetchParams: Record<string, string> | undefined,
  fetchParamPatch?: string,
): Record<string, string> {
  const merged = normalizeStoredFetchParams(existingFetchParams);
  const patch = parseFetchParamPatch(fetchParamPatch);
  if (!patch) return merged;

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

export function getFetchParamValue(fetchParams: Record<string, string> | undefined, key: string): string | undefined {
  if (!fetchParams || typeof fetchParams !== 'object') return undefined;
  return fetchParams[key];
}

export function fetchParamObjectToCliArgs(fetchParams: Record<string, string> | undefined): string[] {
  if (!fetchParams || typeof fetchParams !== 'object') return [];
  return Object.entries(fetchParams).map(([key, value]) => `${key}=${value}`);
}