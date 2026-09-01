/**
 * Slugify a string into a filesystem-safe lowercased dashed stem.
 * Returns the fallback when the input has no slugifiable characters.
 */
export function slugify(input: string, fallback = "content"): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}