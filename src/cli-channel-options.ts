import { mergeFetchParamObject, normalizeFetchParamObject } from './fetch-params';
import { ChannelConfig, DuplicateStrategy, FetchMethod } from './types';

export interface ChannelAddCliOptions {
  type: string;
  fetchParam?: string;
  rateLimit?: string;
  refreshInterval?: string;
  idField?: string;
  duplicateStrategy?: string;
}

export interface ChannelEditCliOptions {
  name?: string;
  type?: string;
  fetchParam?: string;
  rateLimit?: string;
  refreshInterval?: string;
  idField?: string;
  duplicateStrategy?: string;
}

export function parseDuplicateStrategy(value: string | undefined): DuplicateStrategy | undefined {
  if (value === undefined) return undefined;
  if (value === 'overwrite' || value === 'keep-both') return value;
  throw new Error(`Invalid duplicate strategy '${value}'. Expected 'overwrite' or 'keep-both'.`);
}

export function buildChannelAddConfig(name: string, opts: ChannelAddCliOptions): ChannelConfig {
  return {
    name,
    fetchMethod: opts.type as FetchMethod,
    fetchParams: normalizeFetchParamObject(opts.fetchParam),
    rateLimitInterval: opts.rateLimit !== undefined ? parseInt(opts.rateLimit, 10) : undefined,
    refreshInterval: opts.refreshInterval !== undefined ? parseInt(opts.refreshInterval, 10) : undefined,
    idField: opts.idField,
    duplicateStrategy: parseDuplicateStrategy(opts.duplicateStrategy),
  };
}

export function buildChannelEditUpdates(
  existingFetchParams: Record<string, string> | undefined,
  opts: ChannelEditCliOptions,
): Partial<ChannelConfig> {
  const updates: Partial<ChannelConfig> = {};
  if (opts.name) updates.name = opts.name;
  if (opts.type) updates.fetchMethod = opts.type as FetchMethod;
  if (opts.fetchParam !== undefined) {
    updates.fetchParams = mergeFetchParamObject(existingFetchParams, opts.fetchParam);
  }
  if (opts.rateLimit !== undefined) updates.rateLimitInterval = parseInt(opts.rateLimit, 10);
  if (opts.refreshInterval !== undefined) updates.refreshInterval = parseInt(opts.refreshInterval, 10);
  if (opts.idField !== undefined) updates.idField = opts.idField;
  if (opts.duplicateStrategy !== undefined) {
    updates.duplicateStrategy = parseDuplicateStrategy(opts.duplicateStrategy);
  }
  return updates;
}