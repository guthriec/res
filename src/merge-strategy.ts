import type { ContentVersion } from "./version-store";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeDiff3 = require("node-diff3") as {
  diff3Merge(
    ancestor: string[],
    ours: string[],
    theirs: string[],
    options?: { excludeFalseConflicts?: boolean },
  ): Array<
    | { ok: string[] }
    | { conflict: { a: string[]; o: string[]; b: string[] } }
  >;
};
const { diff3Merge } = nodeDiff3;

export type Diff3Region = ReturnType<typeof diff3Merge>[number];

export interface MergeParams {
  /** Last common ancestor version, or null if no shared history */
  ancestor: ContentVersion | null;
  /** Local tip version */
  ours: ContentVersion;
  /** Incoming tip version */
  theirs: ContentVersion;
  /** File content at the LCA, or null if no common ancestor */
  ancestorContent: string | null;
  /** File content at the local tip */
  oursContent: string;
  /** File content at the incoming tip */
  theirsContent: string;
}

export interface MergeStrategy {
  /** Resolve a three-way merge and return the merged content string. */
  merge(params: MergeParams): string;
}

/**
 * Split text into lines, keeping newline characters attached to each line.
 */
function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/);
}

/**
 * An "unsafe" auto-merge strategy that uses three-way merge via `node-diff3`.
 *
 * - Non-conflicting hunks apply cleanly from both sides.
 * - Conflicting hunks resolve by last-writer-wins (LWW) on timestamps.
 * - No conflict markers are ever emitted.
 * - When no common ancestor exists, falls back to LWW on the full content.
 *
 * This is "unsafe" because overlapping edits from the earlier-timestamp side
 * are silently discarded. Designed to be replaced with a CRDT-based strategy.
 */
export class UnsafeAutoMerge implements MergeStrategy {
  merge(params: MergeParams): string {
    const { ancestorContent, oursContent, theirsContent, ours, theirs } = params;

    // No common ancestor: LWW on full content
    if (ancestorContent === null) {
      return ours.timestamp >= theirs.timestamp ? oursContent : theirsContent;
    }

    const ancestorLines = splitLines(ancestorContent);
    const oursLines = splitLines(oursContent);
    const theirsLines = splitLines(theirsContent);

    // diff3Merge(a, o, b) — a=ours, o=ancestor, b=theirs
    const regions: Diff3Region[] = diff3Merge(oursLines, ancestorLines, theirsLines) as Diff3Region[];

    const resolvedLines: string[] = [];
    for (const region of regions) {
      if ("ok" in region && region.ok) {
        resolvedLines.push(...region.ok);
      } else if ("conflict" in region && region.conflict) {
        // conflict.a = ours, conflict.b = theirs — pick by LWW
        const useOurs = ours.timestamp >= theirs.timestamp;
        resolvedLines.push(...(useOurs ? region.conflict.a : region.conflict.b));
      }
    }

    return resolvedLines.join("");
  }
}
