// Lightweight text similarity + clustering. No external deps — term-frequency cosine similarity over a normalized token vector.
import type { Ticket, Cluster } from "./types.js";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

interface Vec {
  terms: Map<string, number>;
  norm: number;
}

function buildVec(tokens: string[]): Vec {
  const terms = termFreq(tokens);
  let norm = 0;
  for (const v of terms.values()) norm += v * v;
  return { terms, norm: Math.sqrt(norm) };
}

function cosine(a: Vec, b: Vec): number {
  if (a.norm === 0 || b.norm === 0) return 0;
  const smaller = a.terms.size <= b.terms.size ? a : b;
  const larger = smaller === a ? b : a;
  let dot = 0;
  for (const [term, v] of smaller.terms) {
    const ov = larger.terms.get(term);
    if (ov !== undefined) dot += v * ov;
  }
  return dot / (a.norm * b.norm);
}

export function textSimilarity(a: string, b: string): number {
  return cosine(buildVec(tokenize(a)), buildVec(tokenize(b)));
}

/**
 * Find the best-matching cluster for a ticket.
 * Returns `{ clusterId, score }` for the cluster whose canonical_title is most
 * similar to the ticket title, or null if no cluster meets `minScore`.
 */
export function findBestCluster(
  ticket: Pick<Ticket, "title">,
  clusters: Pick<Cluster, "id" | "canonical_title">[],
  minScore = 0.45,
): { clusterId: string; score: number } | null {
  let best: { clusterId: string; score: number } | null = null;
  for (const c of clusters) {
    const score = textSimilarity(ticket.title, c.canonical_title);
    if (score >= minScore && (best === null || score > best.score)) {
      best = { clusterId: c.id, score };
    }
  }
  return best;
}

/**
 * Canonical title for a cluster: most frequent 2-4 word n-gram across all ticket titles,
 * falling back to the most common full title, then the newest.
 */
export function computeCanonicalTitle(titles: string[]): string {
  if (titles.length === 0) return "Untitled issue";
  if (titles.length === 1) return titles[0];

  // First, exact-match frequency.
  const exactFreq = new Map<string, number>();
  for (const t of titles) exactFreq.set(t, (exactFreq.get(t) ?? 0) + 1);
  let bestExact = titles[0];
  let bestExactCount = 0;
  for (const [k, v] of exactFreq) {
    if (v > bestExactCount) {
      bestExact = k;
      bestExactCount = v;
    }
  }
  if (bestExactCount >= 2) return bestExact;

  // N-gram frequency for n=2..4.
  const ngramFreq = new Map<string, number>();
  for (const t of titles) {
    const tokens = tokenize(t);
    for (let n = 2; n <= 4 && n <= tokens.length; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n).join(" ");
        ngramFreq.set(gram, (ngramFreq.get(gram) ?? 0) + 1);
      }
    }
  }

  // Score n-grams by frequency * length (longer n-grams are more descriptive).
  let bestGram = "";
  let bestGramScore = 0;
  for (const [gram, count] of ngramFreq) {
    if (count < 2) continue;
    const s = count * gram.split(" ").length;
    if (s > bestGramScore) {
      bestGram = gram;
      bestGramScore = s;
    }
  }

  if (bestGram) return bestGram.charAt(0).toUpperCase() + bestGram.slice(1);
  return bestExact;
}

export function computeCanonicalSummary(bodies: string[]): string | null {
  const nonNull = bodies.filter((b) => b && b.trim().length > 0);
  if (nonNull.length === 0) return null;
  return nonNull[0].slice(0, 240);
}
