/**
 * Panel orchestration: fan one prompt out to several models (with bounded
 * concurrency), collect every answer — a single member failing must not sink the
 * batch — and optionally synthesise them into one view that surfaces disagreement.
 */
import { chatCompletion, type ChatMessage } from "./openrouter.js";
import { dedupe } from "./config.js";

export interface PanelAnswer {
  model: string;
  ok: boolean;
  /** Present when `ok`. */
  content?: string;
  /** Present when `!ok`. */
  error?: string;
  /** Total tokens billed, when the provider reported usage. */
  tokens?: number;
  ms: number;
}

export interface AskPanelParams {
  apiKey: string;
  prompt: string;
  models: string[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  retries?: number;
  /** Max models queried at once (default 4). */
  concurrency?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i] as T, i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Queries every (deduped) model with bounded concurrency. Each member is wrapped
 * so a failure becomes a recorded failed answer rather than a thrown batch — the
 * whole point of a panel is resilience to any one member.
 */
export async function askPanel(params: AskPanelParams): Promise<PanelAnswer[]> {
  const models = dedupe(params.models);

  const messages: ChatMessage[] = [];
  if (params.system && params.system.trim()) {
    messages.push({ role: "system", content: params.system });
  }
  messages.push({ role: "user", content: params.prompt });

  return mapWithLimit(models, params.concurrency ?? 4, async (model): Promise<PanelAnswer> => {
    const started = Date.now();
    try {
      const { content, usage } = await chatCompletion({
        apiKey: params.apiKey,
        model,
        messages,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        timeoutMs: params.timeoutMs,
        retries: params.retries,
        fetchImpl: params.fetchImpl,
        sleepImpl: params.sleepImpl,
      });
      return { model, ok: true, content, tokens: usage?.totalTokens, ms: Date.now() - started };
    } catch (err) {
      return {
        model,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      };
    }
  });
}

export interface SynthesizeParams {
  apiKey: string;
  prompt: string;
  answers: PanelAnswer[];
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Asks one model to compare the panel's answers. The instruction deliberately
 * tells it to SURFACE disagreement rather than average it away — a single
 * confident consensus is exactly what a second opinion is meant to break.
 */
export async function synthesize(params: SynthesizeParams): Promise<string> {
  const ok = params.answers.filter((a) => a.ok);
  if (ok.length === 0) throw new Error("no successful answers to synthesize");

  const transcript = ok
    .map((a, i) => `### Expert ${i + 1} — ${a.model}\n${a.content}`)
    .join("\n\n");

  const system =
    "You are a careful aggregator comparing answers from several AI models to the same question. " +
    "Identify where they AGREE and, just as importantly, where they DISAGREE — name the conflict explicitly " +
    "instead of averaging it away. Then give a short, honest bottom line. Be concise.";

  const user =
    `Original question:\n${params.prompt}\n\n` +
    `Answers from the panel:\n\n${transcript}\n\n` +
    "Write: (1) Points of agreement, (2) Points of disagreement or divergence, (3) Bottom line.";

  const { content } = await chatCompletion({
    apiKey: params.apiKey,
    model: params.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens: params.maxTokens ?? 1024,
    timeoutMs: params.timeoutMs,
    retries: params.retries,
    fetchImpl: params.fetchImpl,
    sleepImpl: params.sleepImpl,
  });
  return content;
}

/** Renders the panel (and optional synthesis) as Markdown for the MCP response. */
export function formatResult(
  prompt: string,
  answers: PanelAnswer[],
  synthesis?: string,
): string {
  const lines: string[] = [];
  lines.push(`# Second opinion — ${answers.length} models`);
  lines.push("");
  lines.push(`**Question:** ${prompt}`);
  lines.push("");

  for (const a of answers) {
    const meta = a.ok
      ? `(${a.ms}ms${a.tokens ? `, ${a.tokens} tok` : ""})`
      : "— FAILED";
    lines.push(`## ${a.model} ${meta}`);
    lines.push(a.ok ? (a.content ?? "") : `> error: ${a.error}`);
    lines.push("");
  }

  if (synthesis) {
    lines.push("## 🔎 Synthesis");
    lines.push(synthesis);
    lines.push("");
  }

  const failed = answers.filter((a) => !a.ok).length;
  const totalTokens = answers.reduce((s, a) => s + (a.tokens ?? 0), 0);
  const footer: string[] = [];
  if (totalTokens > 0) footer.push(`${totalTokens} tokens total`);
  if (failed > 0) footer.push(`${failed} of ${answers.length} model(s) failed`);
  if (footer.length) lines.push(`_${footer.join(" · ")}._`);

  return lines.join("\n").trim();
}
