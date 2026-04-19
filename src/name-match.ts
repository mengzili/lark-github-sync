/**
 * Name-based fuzzy matching for GitHub↔Lark users whose emails differ.
 *
 * Pipeline:
 *   1. Normalize — lowercase, strip punctuation, collapse whitespace.
 *   2. Pinyin — convert CJK characters to pinyin (e.g. "张伟" → "zhang wei").
 *   3. Score — token-set Jaccard blended with normalized Levenshtein.
 *
 * Thresholds (tuned for two-sided CJK + ASCII name matching):
 *   ≥ 0.95 → auto-match
 *   0.70–0.95 → candidate for human approval
 *   < 0.70 → no candidate
 */

import { pinyin } from 'pinyin-pro';

export const AUTO_MATCH_THRESHOLD = 0.95;
export const CANDIDATE_THRESHOLD = 0.7;

const HAS_CJK = /[\u3400-\u9fff]/;

export function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u2000-\u206f]/g, ' ') // Unicode punctuation/spaces → space
    .replace(/[._\-,·・]+/g, ' ')
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert a name containing CJK characters to pinyin (space-separated). Non-CJK passes through. */
export function pinyinOf(name: string): string {
  if (!HAS_CJK.test(name)) return normalize(name);
  const py = pinyin(name, { toneType: 'none', type: 'array' });
  return normalize(py.join(' '));
}

/** All reasonable string forms to compare for a single name. */
function forms(name: string): string[] {
  const set = new Set<string>();
  set.add(normalize(name));
  const p = pinyinOf(name);
  if (p) set.add(p);
  // Also try joined-no-spaces form ("zhangwei") — a common GitHub-handle shape
  set.add(p.replace(/\s+/g, ''));
  set.add(normalize(name).replace(/\s+/g, ''));
  return [...set].filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const m = a.length;
  const n = b.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function levRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenSetRatio(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;

  // fuzzywuzzy-ish: also consider the intersection as its own sorted string
  const intersect = [...ta].filter((x) => tb.has(x)).sort();
  const diffA = [...ta].filter((x) => !tb.has(x)).sort();
  const diffB = [...tb].filter((x) => !ta.has(x)).sort();

  const t0 = intersect.join(' ');
  const t1 = (intersect.concat(diffA)).join(' ');
  const t2 = (intersect.concat(diffB)).join(' ');

  const r1 = levRatio(t0, t1);
  const r2 = levRatio(t0, t2);
  const r3 = levRatio(t1, t2);
  const j = jaccard(ta, tb);
  return Math.max(r1, r2, r3, j);
}

/** Best match score over all normalized forms of both names. 0..1. */
export function score(a: string, b: string): number {
  const formsA = forms(a);
  const formsB = forms(b);
  let best = 0;
  for (const fa of formsA) {
    for (const fb of formsB) {
      const tsr = tokenSetRatio(fa, fb);
      const lr = levRatio(fa, fb);
      best = Math.max(best, tsr, lr);
      if (best === 1) return 1;
    }
  }
  return best;
}

/**
 * Find the top-K candidates in `pool` that best match `target`.
 * Returns entries with `score >= CANDIDATE_THRESHOLD`, sorted descending.
 */
export function bestMatches<T extends { name: string }>(
  target: string,
  pool: T[],
  k = 3,
): Array<{ item: T; score: number }> {
  return pool
    .map((item) => ({ item, score: score(target, item.name) }))
    .filter((x) => x.score >= CANDIDATE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Helper: does this pair beat the auto-match bar? */
export function isAutoMatch(s: number): boolean {
  return s >= AUTO_MATCH_THRESHOLD;
}
