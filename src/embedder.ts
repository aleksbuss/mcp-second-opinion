/**
 * Builds an `Embedder` backed by OpenRouter's embeddings endpoint — the same key
 * as the chat panel, so disagreement scoring needs no second provider and no local
 * model. (The plan originally assumed local embeddings; OpenRouter turned out to
 * expose `/embeddings` — see POST_MORTEMS #5.)
 */
import { embed } from "./openrouter.js";
import type { Embedder } from "./disagreement.js";

export const DEFAULT_EMBED_MODEL = "openai/text-embedding-3-small";

export function makeOpenRouterEmbedder(
  apiKey: string,
  model: string = DEFAULT_EMBED_MODEL,
  timeoutMs?: number,
): Embedder {
  return (texts) => embed({ apiKey, model, input: texts, timeoutMs });
}
