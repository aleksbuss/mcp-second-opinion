/**
 * Pure configuration helpers — extracted from the server entry so they can be
 * unit-tested without spinning up a process or reading real environment.
 */

export const DEFAULT_MODELS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.5-flash-lite",
];
export const DEFAULT_SYNTH = "openai/gpt-4o-mini";

/** Hard ceiling on panel size — fan-out is N paid calls; refuse to footgun. */
export const MAX_MODELS = 8;

/** Parse a comma-separated model list, falling back to `fallback` when empty. */
export function parseModels(raw: string | undefined, fallback = DEFAULT_MODELS): string[] {
  if (!raw) return [...fallback];
  const list = raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [...fallback];
}

/** Remove duplicates while preserving first-seen order. */
export function dedupe(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    const k = m.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Normalise a requested model list: dedupe, drop blanks, and cap at `max`.
 * Returns the cleaned list plus how many were dropped by the cap (for messaging).
 */
export function normalizeModels(
  models: string[],
  max = MAX_MODELS,
): { models: string[]; dropped: number } {
  const clean = dedupe(models);
  if (clean.length <= max) return { models: clean, dropped: 0 };
  return { models: clean.slice(0, max), dropped: clean.length - max };
}

/** Parse a positive integer env var, falling back to `fallback`. */
export function parseIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Parse a temperature env var (0..2), falling back to `fallback`. */
export function parseTempEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : fallback;
}
