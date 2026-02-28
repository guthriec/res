import {
  Channel,
  DEFAULT_DUPLICATE_STRATEGY,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  DuplicateStrategy,
  GLOBAL_LOCK_NAME,
} from './types';
import { normalizeFetchParams } from './fetch-params';

type RawChannelInput = Channel | (Omit<Channel, 'refreshInterval'> & { refreshInterval?: number });

export class InputNormalizer {
  static idField(idField?: string): string | undefined {
    if (typeof idField !== 'string') return undefined;
    const normalized = idField.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  static duplicateStrategy(value?: DuplicateStrategy | string): DuplicateStrategy {
    if (value === undefined) return DEFAULT_DUPLICATE_STRATEGY;
    if (value === 'overwrite' || value === 'keep-both') return value;
    throw new Error(`Invalid duplicate strategy '${value}'. Expected 'overwrite' or 'keep-both'.`);
  }

  static channel(rawChannel: RawChannelInput): Channel {
    const raw = rawChannel as Channel & { retentionStrategy?: unknown; fetchArgs?: Record<string, string> };
    const rawRefresh = raw.refreshInterval;
    const refreshInterval =
      typeof rawRefresh === 'number' && Number.isFinite(rawRefresh) && rawRefresh > 0
        ? rawRefresh
        : DEFAULT_REFRESH_INTERVAL_SECONDS;
    return {
      id: raw.id,
      createdAt: raw.createdAt,
      name: raw.name,
      fetchMethod: raw.fetchMethod,
      fetchParams: normalizeFetchParams(raw.fetchParams ?? raw.fetchArgs),
      rateLimitInterval: typeof raw.rateLimitInterval === 'number' ? raw.rateLimitInterval : undefined,
      refreshInterval,
      idField: InputNormalizer.idField(raw.idField),
      duplicateStrategy: InputNormalizer.duplicateStrategy(raw.duplicateStrategy),
      retainedLocks: InputNormalizer.locks(rawChannel.retainedLocks),
    };
  }

  static lockName(lockName?: string): string {
    if (lockName === undefined) return GLOBAL_LOCK_NAME;
    const normalized = lockName.trim();
    if (normalized.includes(',')) {
      throw new Error('Invalid lock name: commas are not allowed');
    }
    return normalized.length > 0 ? normalized : GLOBAL_LOCK_NAME;
  }

  static locks(lockNames?: string[], options: { validateNames?: boolean } = {}): string[] {
    if (!Array.isArray(lockNames) || lockNames.length === 0) return [];
    const validateNames = options.validateNames ?? false;
    const unique = new Set<string>();
    for (const lockName of lockNames) {
      if (typeof lockName !== 'string') continue;
      const normalized = lockName.trim();
      if (!normalized) continue;
      if (validateNames && normalized.includes(',')) {
        throw new Error('Invalid lock name: commas are not allowed');
      }
      unique.add(normalized);
    }
    return [...unique];
  }
}