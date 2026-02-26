import { fetchArgObjectToCliArgs, getFetchArgValue, mergeFetchArgObject, normalizeFetchArgObject } from '../src/fetch-args';

describe('fetch-args utilities', () => {
  it('normalizes key=value fetch args into an object and keeps last value per key', () => {
    const normalized = normalizeFetchArgObject([
      ' url=https://example.com/feed ',
      'timeout=10',
      'timeout=30',
    ]);

    expect(normalized).toEqual({ url: 'https://example.com/feed', timeout: '30' });
  });

  it('throws when a fetch arg is not key=value', () => {
    expect(() => normalizeFetchArgObject(['https://example.com/feed'])).toThrow('Expected key=value');
  });

  it('merges only provided keys during edit updates', () => {
    const merged = mergeFetchArgObject(
      { url: 'https://example.com/feed', timeout: '10', mode: 'full' },
      ['timeout=60'],
    );

    expect(merged).toEqual({ url: 'https://example.com/feed', timeout: '60', mode: 'full' });
  });

  it('removes a key when edited with a blank value', () => {
    const merged = mergeFetchArgObject(
      { url: 'https://example.com/feed', timeout: '10' },
      ['timeout='],
    );

    expect(merged).toEqual({ url: 'https://example.com/feed' });
  });

  it('extracts values by key from fetch args', () => {
    expect(getFetchArgValue({ url: 'https://example.com', timeout: '10' }, 'url')).toBe('https://example.com');
    expect(getFetchArgValue({ url: 'https://example.com', timeout: '10' }, 'missing')).toBeUndefined();
  });

  it('converts fetch arg object into CLI key=value args', () => {
    const cliArgs = fetchArgObjectToCliArgs({ url: 'https://example.com', timeout: '10' });
    expect(cliArgs).toEqual(['url=https://example.com', 'timeout=10']);
  });
});
