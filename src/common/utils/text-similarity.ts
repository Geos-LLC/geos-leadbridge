/**
 * Token-Jaccard similarity for short free-text fields like Lead.message.
 *
 * Used by the refundable-lead duplicate detector to decide whether two
 * leads describe a "similar request". Threshold per spec: ≥ 0.5 ⇒ flag.
 *
 * Algorithm: lowercase, strip non-alpha tokens, split on whitespace,
 * remove a small English stopword set, dedupe, then
 *     |A ∩ B| / |A ∪ B|.
 *
 * Returns 0 when either input is empty or has no informative tokens
 * after stripping (so empty/empty doesn't false-positive as 1.0).
 *
 * Pure function, no I/O. Deterministic.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'do', 'for', 'from', 'has', 'have', 'i', 'if', 'im', 'in', 'is',
  'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'so',
  'the', 'to', 'up', 'we', 'with', 'you', 'your', 'this', 'that',
  'will', 'would', 'can', 'need', 'want', 'like',
]);

function tokenize(input: string | null | undefined): Set<string> {
  if (!input) return new Set();
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

export function jaccardSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection++;
  const union = A.size + B.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
