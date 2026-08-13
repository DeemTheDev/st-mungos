// Deterministic text matching shared by the session engine (engine-gated
// disclosure, exam-step mapping, investigation requests) and the MockBrain's
// marking heuristics. No LLM anywhere in this file — this is the layer that
// makes the whole flow playable and testable at $0 (DECISIONS.md).

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One word with simple stem tolerance: "test" matches tested/testing/tests. */
const wordPattern = (word: string): string => `${escapeRegExp(word)}(?:s|es|ed|d|ing)?`;

/**
 * Does the (already normalized) utterance contain this trigger? Word-boundary
 * matching with stem tolerance; multi-word triggers match as a phrase.
 */
export function matchesTrigger(normalizedUtterance: string, trigger: string): boolean {
  const words = normalizeText(trigger).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  const pattern = new RegExp(`\\b${words.map(wordPattern).join("\\s+")}\\b`);
  return pattern.test(normalizedUtterance);
}

export function matchesAnyTrigger(normalizedUtterance: string, triggers: readonly string[]): boolean {
  return triggers.some((t) => matchesTrigger(normalizedUtterance, t));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "her", "his", "she", "has", "have", "had", "was", "were",
  "not", "any", "all", "are", "you", "your", "that", "this", "than", "then", "into",
  "about", "from", "per", "once", "when", "where", "what", "which", "who", "how",
  "does", "did", "been", "being", "would", "should", "could", "will", "can", "may",
  "patient", "asks", "takes", "gives", "offers", "performs", "states", "notes",
]);

/** Very light stemmer so "notified" ≈ "notify", "screening" ≈ "screens". */
export function stem(word: string): string {
  return word
    .replace(/(ations?|ings?|ies|ied|ers?|es|ed|s)$/u, "")
    .replace(/(.)\1$/u, "$1"); // "planning" → "plann" → "plan"
}

/** Significant, stemmed tokens of a text (stop words and short words dropped). */
export function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeText(text).split(" ")) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    // Numeric tokens (e.g. "187", "7.28"→"7 28") are kept verbatim — numbers
    // are strong evidence in marking.
    out.add(/\d/.test(raw) ? raw : stem(raw));
  }
  return out;
}

/** Count of shared significant tokens between two texts. */
export function tokenOverlap(a: string, b: string): number {
  const ta = significantTokens(a);
  const tb = significantTokens(b);
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n;
}
