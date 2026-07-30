import { UnsafeAutoMerge, type MergeParams } from "../src/merge-strategy";
import type { ContentVersion } from "../src/version-store";

function version(id: string, timestamp: string, parentIds?: string[]): ContentVersion {
  return { id, parentIds: parentIds ?? [], hash: "abc", timestamp };
}

const T_EARLY = "2026-01-01T00:00:00Z";
const T_LATE = "2026-01-02T00:00:00Z";

function makeParams(overrides: Partial<MergeParams> = {}): MergeParams {
  const ancestor = overrides.ancestor ?? version("v1", T_EARLY);
  const ours = overrides.ours ?? version("v2", T_EARLY, [ancestor.id]);
  const theirs = overrides.theirs ?? version("v2r", T_EARLY, [ancestor.id]);

  return {
    ancestor,
    ours,
    theirs,
    ancestorContent: overrides.ancestorContent ?? "line1\nline2\nline3\n",
    oursContent: overrides.oursContent ?? "line1\nline2\nline3\n",
    theirsContent: overrides.theirsContent ?? "line1\nline2\nline3\n",
  };
}

describe("UnsafeAutoMerge", () => {
  const strategy = new UnsafeAutoMerge();

  it("returns identical content when both sides match ancestor", () => {
    const result = strategy.merge(
      makeParams({
        ancestorContent: "a\nb\n",
        oursContent: "a\nb\n",
        theirsContent: "a\nb\n",
      }),
    );
    expect(result).toBe("a\nb\n");
  });

  it("accepts the only side that changed when the other matches ancestor", () => {
    const result = strategy.merge(
      makeParams({
        ancestorContent: "a\nb\nc\n",
        oursContent: "a\nMODIFIED\nc\n",
        theirsContent: "a\nb\nc\n",
      }),
    );
    expect(result).toBe("a\nMODIFIED\nc\n");
  });

  it("resolves overlapping conflicts by LWW (ours wins when newer)", () => {
    const result = strategy.merge(
      makeParams({
        ours: version("v2", T_LATE),
        theirs: version("v2r", T_EARLY),
        ancestorContent: "line1\noriginal\nline3\n",
        oursContent: "line1\nours\nline3\n",
        theirsContent: "line1\ntheirs\nline3\n",
      }),
    );
    expect(result).toBe("line1\nours\nline3\n");
  });

  it("resolves overlapping conflicts by LWW (theirs wins when newer)", () => {
    const result = strategy.merge(
      makeParams({
        ours: version("v2", T_EARLY),
        theirs: version("v2r", T_LATE),
        ancestorContent: "line1\noriginal\nline3\n",
        oursContent: "line1\nours\nline3\n",
        theirsContent: "line1\ntheirs\nline3\n",
      }),
    );
    expect(result).toBe("line1\ntheirs\nline3\n");
  });

  it("uses LWW on full content when ancestor is null", () => {
    const result = strategy.merge(
      makeParams({
        ancestor: null,
        ancestorContent: null,
        ours: version("v1", T_EARLY),
        theirs: version("v1r", T_LATE),
        oursContent: "from ours\n",
        theirsContent: "from theirs\n",
      }),
    );
    expect(result).toBe("from theirs\n");
  });

  it("handles empty files", () => {
    const result = strategy.merge(
      makeParams({
        ancestorContent: "",
        oursContent: "",
        theirsContent: "",
      }),
    );
    expect(result).toBe("");
  });

  it("picks a side when adjacent lines conflict (LWW)", () => {
    // Both sides modify adjacent lines — diff3 treats as a single conflict region.
    // With equal timestamps, oursContent wins.
    const result = strategy.merge(
      makeParams({
        ancestorContent: "line1\nline2\nline3\n",
        oursContent: "line1\nUS\nline3\n",
        theirsContent: "line1\nline2\nTHEY\n",
      }),
    );
    expect(result).toBe("line1\nUS\nline3\n");
  });

  it("handles trailing-newline addition conflict with LWW", () => {
    // Ancestor has no trailing line, ours and theirs each add different content.
    // With equal timestamps, ours wins.
    const result = strategy.merge(
      makeParams({
        ancestorContent: "a\nb\n",
        oursContent: "a\nb\nc\n",
        theirsContent: "a\nb\nd\n",
      }),
    );
    expect(result).toBe("a\nb\nc\n");
  });

  it("accepts a single-side change on a single-line file", () => {
    const result = strategy.merge(
      makeParams({
        ancestorContent: "hello",
        oursContent: "hello world",
        theirsContent: "hello",
      }),
    );
    expect(result).toBe("hello world");
  });
});
