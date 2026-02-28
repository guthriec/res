export class ContentParser {
  static parseInlineFrontmatter(rawContent: string): Record<string, string> {
    if (!rawContent.startsWith('---\n')) return {};
    const endIdx = rawContent.indexOf('\n---\n', 4);
    if (endIdx === -1) return {};

    const header = rawContent.slice(4, endIdx).split('\n');
    const fields: Record<string, string> = {};

    for (const line of header) {
      const sep = line.indexOf(':');
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      if (!key) continue;
      const value = line.slice(sep + 1).trim();
      fields[key] = ContentParser.parseMaybeJsonString(value);
    }

    return fields;
  }

  static inferTitleFromContent(rawContent: string): string | undefined {
    const fields = ContentParser.parseInlineFrontmatter(rawContent);
    const frontmatterTitle = fields.title?.trim();
    if (frontmatterTitle && frontmatterTitle.length > 0) {
      return frontmatterTitle;
    }

    const body = ContentParser.stripInlineFrontmatter(rawContent);
    const lines = body.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*#\s+(.+?)\s*#*\s*$/);
      if (!match) continue;
      const heading = match[1].trim();
      if (heading.length > 0) {
        return heading;
      }
    }

    return undefined;
  }

  private static stripInlineFrontmatter(rawContent: string): string {
    if (!rawContent.startsWith('---\n')) {
      return rawContent;
    }
    const endIdx = rawContent.indexOf('\n---\n', 4);
    if (endIdx === -1) {
      return rawContent;
    }
    return rawContent.slice(endIdx + 5);
  }

  private static parseMaybeJsonString(value: string): string {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : value;
    } catch {
      return value;
    }
  }
}