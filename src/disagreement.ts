/**
 * Disagreement scoring — turn "the models disagree" from prose into a number.
 *
 * Embed each answer, take pairwise cosine *distance* (1 − similarity) over the
 * panel, and report how far apart they are. Mirrors Orchestra's embedding-based
 * disagreement detection (threshold 0.35): a panel whose answers cluster tightly
 * agrees; one with a far-apart pair is genuinely divided, and the synthesizer is
 * then told to surface the conflict rather than average it away.
 *
 * The `Embedder` is injected (same pattern as `fetchImpl`/`sleepImpl`), so the
 * maths is unit-tested with preset vectors — no model, no network, no key.
 */

/** Maps texts to vectors. Local model, API, or a fake in tests — caller's choice. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Orchestra's threshold: max pairwise distance above this = a divided panel. */
export const DEFAULT_DISAGREE_THRESHOLD = 0.35;

/**
 * Cap on per-answer characters sent to the embedder (~4k tokens, well under the
 * 8191-token limit of typical embedding models). A long answer that blew the
 * limit would fail the *whole* embed call and silently cost the panel its score;
 * the head of an answer is plenty to capture its semantic gist for distance.
 */
export const MAX_EMBED_CHARS = 16_000;

export interface AnswerForScoring {
  model: string;
  content: string;
}

export interface DisagreementReport {
  /** Mean pairwise distance across the panel (0 = identical … 1 = unrelated). */
  score: number;
  /** Largest pairwise distance — the signal that drives `flagged`. */
  maxDistance: number;
  /** The two models that diverged the most. */
  mostDivergentPair: [string, string];
  /** True when `maxDistance` exceeds the threshold (the panel is genuinely split). */
  flagged: boolean;
  /** Models that were actually compared (successful, non-empty answers). */
  models: string[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Cosine similarity in [-1, 1]; 0 if either vector is zero-length (undefined
 * direction). Throws on a dimension mismatch — same embed model means same
 * dimensions, so a mismatch is a broken invariant we want to fail loudly on
 * rather than silently truncate to a wrong number.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Distance = 1 − cosine similarity, clamped to [0, 1] for an interpretable score. */
export function cosineDistance(a: number[], b: number[]): number {
  return clamp01(1 - cosineSimilarity(a, b));
}

export interface PairwiseResult {
  score: number;
  maxDistance: number;
  maxPair: [number, number];
  flagged: boolean;
}

/**
 * Aggregate pairwise distances over `vectors` (≥2 required). Returns the mean
 * distance, the max, the index pair that produced the max, and whether the max
 * crosses `threshold`.
 */
export function pairwiseDisagreement(
  vectors: number[][],
  threshold = DEFAULT_DISAGREE_THRESHOLD,
): PairwiseResult {
  if (vectors.length < 2) {
    throw new Error("pairwiseDisagreement needs at least 2 vectors");
  }
  let sum = 0;
  let count = 0;
  let maxDistance = -1;
  let maxPair: [number, number] = [0, 1];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const d = cosineDistance(vectors[i] as number[], vectors[j] as number[]);
      sum += d;
      count++;
      if (d > maxDistance) {
        maxDistance = d;
        maxPair = [i, j];
      }
    }
  }
  return {
    score: sum / count,
    maxDistance,
    maxPair,
    flagged: maxDistance > threshold,
  };
}

/** A short human label for how divided the panel is, from the max distance. */
export function disagreementLabel(maxDistance: number): string {
  if (maxDistance < 0.15) return "strong consensus";
  if (maxDistance < DEFAULT_DISAGREE_THRESHOLD) return "broad agreement";
  if (maxDistance < 0.5) return "notable disagreement";
  return "strong disagreement";
}

/**
 * Embed the (successful) answers and score how much they disagree. Returns `null`
 * — never throws — when there's nothing to compare (<2 answers) or the embedder
 * fails: disagreement scoring is a best-effort layer and must never sink the panel.
 */
export async function scoreDisagreement(
  answers: AnswerForScoring[],
  embedder: Embedder,
  threshold = DEFAULT_DISAGREE_THRESHOLD,
): Promise<DisagreementReport | null> {
  const usable = answers.filter((a) => a.content.trim().length > 0);
  if (usable.length < 2) return null;

  try {
    // Truncate each answer so one long one can't blow the embedder's input limit
    // and cost the whole panel its score.
    const vectors = await embedder(usable.map((a) => a.content.slice(0, MAX_EMBED_CHARS)));
    if (vectors.length !== usable.length) return null;
    const r = pairwiseDisagreement(vectors, threshold);
    const [i, j] = r.maxPair;
    return {
      score: r.score,
      maxDistance: r.maxDistance,
      mostDivergentPair: [usable[i]!.model, usable[j]!.model],
      flagged: r.flagged,
      models: usable.map((a) => a.model),
    };
  } catch {
    return null;
  }
}
