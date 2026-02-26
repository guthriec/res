import {
  fetchParamObjectToCliArgs,
  getFetchParamValue,
  mergeFetchParamObject,
  normalizeFetchParamObject,
} from '../src/fetch-params';

describe('fetch-params utilities', () => {
  it('normalizes JSON patch object into fetch params object', () => {
    const normalized = normalizeFetchParamObject('{"url":" https://example.com/feed ","timeout":30,"enabled":true}');

    expect(normalized).toEqual({
      url: 'https://example.com/feed',
      timeout: '30',
      enabled: 'true',
    });
  });

  it('ignores null values while building add-channel params', () => {
    const normalized = normalizeFetchParamObject('{"url":"https://example.com/feed","timeout":null}');
    expect(normalized).toEqual({ url: 'https://example.com/feed' });
  });

  it('throws when fetch params patch is not valid JSON', () => {
    expect(() => normalizeFetchParamObject('{url:https://example.com/feed}')).toThrow('expected valid JSON object syntax');
  });

  it('throws when fetch params patch is not a JSON object', () => {
    expect(() => normalizeFetchParamObject('["url=https://example.com/feed"]')).toThrow('expected a JSON object');
  });

  it('merges only provided keys during edit updates', () => {
    const merged = mergeFetchParamObject(
      { url: 'https://example.com/feed', timeout: '10', mode: 'full' },
      '{"timeout":60}',
    );

    expect(merged).toEqual({ url: 'https://example.com/feed', timeout: '60', mode: 'full' });
  });

  it('removes a key when edited with null', () => {
    const merged = mergeFetchParamObject(
      { url: 'https://example.com/feed', timeout: '10' },
      '{"timeout":null}',
    );

    expect(merged).toEqual({ url: 'https://example.com/feed' });
  });

  it('extracts values by key from fetch params', () => {
    expect(getFetchParamValue({ url: 'https://example.com', timeout: '10' }, 'url')).toBe('https://example.com');
    expect(getFetchParamValue({ url: 'https://example.com', timeout: '10' }, 'missing')).toBeUndefined();
  });

  it('converts fetch param object into CLI key=value args', () => {
    const cliArgs = fetchParamObjectToCliArgs({ url: 'https://example.com', timeout: '10' });
    expect(cliArgs).toEqual(['url=https://example.com', 'timeout=10']);
  });
});
