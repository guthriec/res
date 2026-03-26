import { ContentParser } from "../src/content-parser";

describe("ContentParser.writeInlineFrontmatter", () => {
  it("updates existing frontmatter values and adds new keys", () => {
    // GIVEN
    const source = ["---", 'title: "Old Title"', 'status: "unread"', "---", "", "# Heading"].join(
      "\n",
    );

    // WHEN
    const updated = ContentParser.writeInlineFrontmatter(source, {
      title: "New Title",
      rating: "5",
    });

    // THEN
    expect(ContentParser.parseInlineFrontmatter(updated)).toEqual({
      title: "New Title",
      status: "unread",
      rating: "5",
    });
    expect(updated.endsWith("# Heading")).toBe(true);
  });

  it("removes keys when value is null", () => {
    // GIVEN
    const source = ["---", 'title: "A"', 'status: "unread"', "---", "", "body"].join("\n");

    // WHEN
    const updated = ContentParser.writeInlineFrontmatter(source, { status: null });

    // THEN
    expect(ContentParser.parseInlineFrontmatter(updated)).toEqual({ title: "A" });
  });

  it("creates frontmatter when source has none", () => {
    // GIVEN
    const source = "# No frontmatter";

    // WHEN
    const updated = ContentParser.writeInlineFrontmatter(source, { status: "read" });

    // THEN
    expect(ContentParser.parseInlineFrontmatter(updated)).toEqual({ status: "read" });
    expect(updated.endsWith("# No frontmatter")).toBe(true);
  });
});
