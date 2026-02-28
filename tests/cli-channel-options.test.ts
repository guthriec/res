import { buildChannelEditUpdates, parseDuplicateStrategy } from '../src/cli-channel-options';

describe('cli channel option parsing', () => {
  it('rejects invalid duplicate-strategy values', () => {
    expect(() => parseDuplicateStrategy('replace')).toThrow(
      "Invalid duplicate strategy 'replace'. Expected 'overwrite' or 'keep-both'.",
    );
  });

  it('accepts valid duplicate-strategy values', () => {
    expect(parseDuplicateStrategy('overwrite')).toBe('overwrite');
    expect(parseDuplicateStrategy('keep-both')).toBe('keep-both');
  });

  it('maps --id-field edit option into channel updates', () => {
    const updates = buildChannelEditUpdates(
      { url: 'https://example.com/feed' },
      { idField: 'externalId' },
    );

    expect(updates.idField).toBe('externalId');
  });

  it('maps duplicate strategy on edit updates', () => {
    const updates = buildChannelEditUpdates(
      { url: 'https://example.com/feed' },
      { duplicateStrategy: 'overwrite' },
    );

    expect(updates.duplicateStrategy).toBe('overwrite');
  });
});