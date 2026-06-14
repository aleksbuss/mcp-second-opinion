/**
 * The `second_opinion` flow, lifted out of the MCP wiring so the glue —
 * key check → resolve models → fan out → score disagreement → synthesize →
 * compose — is unit-testable with an injected `fetch` and `embedder` (no server,
 * no network, no key). `index.ts` is then a thin adapter: it reads the
 * environment into a `SecondOpinionConfig`, builds the real embedder, and calls
 * this. Everything load-bearing in a tool call now has a regression test.
 */
import { askPanel, synthesize, composeResult } from "./panel.js";
import { resolveModels } from "./config.js";
import { scoreDisagreement, type Embedder } from "./disagreement.js";

export interface SecondOpinionArgs {
  prompt: string;
  models?: string[];
  synthesize?: boolean;
  system?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface SecondOpinionConfig {
  apiKey: string;
  defaultPanel: string[];
  synthModel: string;
  timeoutMs: number;
  defaultMaxTokens: number;
  defaultTemperature: number;
  concurrency: number;
  embeddingsOn: boolean;
  disagreeThreshold: number;
  maxModels: number;
}

export interface SecondOpinionDeps {
  /** Embeds answers for disagreement scoring — injected so the flow is testable without a network. */
  embedder: Embedder;
  /** Injected for tests; the panel/synth default to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so retry backoff doesn't actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export const KEY_MISSING_TEXT =
  "OPENROUTER_API_KEY is not set. Add it to the server's environment (get a key at https://openrouter.ai/keys).";

/**
 * Run the full panel flow and return the Markdown result + whether to flag
 * `isError`. Never throws: a per-model failure is recorded (not raised), the
 * disagreement score is best-effort, and synthesis failure degrades to a note.
 */
export async function runSecondOpinion(
  args: SecondOpinionArgs,
  cfg: SecondOpinionConfig,
  deps: SecondOpinionDeps,
): Promise<{ text: string; isError: boolean }> {
  if (!cfg.apiKey) return { text: KEY_MISSING_TEXT, isError: true };

  // Falls back to the default panel if `models` is omitted OR normalises to empty
  // (e.g. only-whitespace ids that the schema's min(1) doesn't catch).
  const { models, dropped } = resolveModels(args.models, cfg.defaultPanel, cfg.maxModels);

  const answers = await askPanel({
    apiKey: cfg.apiKey,
    prompt: args.prompt,
    models,
    system: args.system,
    maxTokens: args.max_tokens ?? cfg.defaultMaxTokens,
    temperature: args.temperature ?? cfg.defaultTemperature,
    timeoutMs: cfg.timeoutMs,
    concurrency: cfg.concurrency,
    fetchImpl: deps.fetchImpl,
    sleepImpl: deps.sleepImpl,
  });

  // Best-effort disagreement score: embed the successful answers and measure how
  // far apart they are. Returns null (never throws) on <2 answers or embed failure,
  // so a missing score can't slow or sink the panel.
  const okForScoring = answers
    .filter((a) => a.ok && a.content)
    .map((a) => ({ model: a.model, content: a.content as string }));
  const disagreement =
    cfg.embeddingsOn && okForScoring.length >= 2
      ? await scoreDisagreement(okForScoring, deps.embedder, cfg.disagreeThreshold)
      : null;

  let synthesis: string | undefined;
  if (args.synthesize && answers.some((a) => a.ok)) {
    try {
      synthesis = await synthesize({
        apiKey: cfg.apiKey,
        prompt: args.prompt,
        answers,
        model: cfg.synthModel,
        // When the panel is flagged as divided, tell the synthesizer to centre the conflict.
        emphasizeConflict: disagreement?.flagged ?? false,
        timeoutMs: cfg.timeoutMs,
        fetchImpl: deps.fetchImpl,
        sleepImpl: deps.sleepImpl,
      });
    } catch (err) {
      synthesis = `_(synthesis failed: ${err instanceof Error ? err.message : String(err)})_`;
    }
  }

  return composeResult(args.prompt, answers, {
    synthesis,
    disagreement,
    dropped,
    maxModels: cfg.maxModels,
  });
}
