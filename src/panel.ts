/**
 * Panel orchestration: fan one prompt out to several models in parallel,
 * collect every answer (a single model failing must not sink the batch), and
 * optionally synthesise them into one consensus-with-disagreement view.
 */
import { chatCompletion, type ChatMessage } from "./openrouter.js";

export interface PanelAnswer {
  model: string;
  ok: boolean;
  /** Present when `ok`. */
  content?: string;
  /** Present when `!ok`. */
  error?: string;
  ms: number;
}

export interface AskPanelParams {
  apiKey: string;
  prompt: string;
  models: string[];
  system?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Queries every model concurrently. Uses `Promise.allSettled` so a slow or
 * failing model is recorded as a failed answer rather than throwing — the whole
 * point of a panel is resilience to any one member.
 */
export async function askPanel(params: AskPanelParams): Promise<PanelAnswer[]> {
  const { apiKey, prompt, models, system, maxTokens, timeoutMs, fetchImpl } = params;

  const messages: ChatMessage[] = [];
  if (system && system.trim()) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const settled = await Promise.allSettled(
    models.map(async (model): Promise<PanelAnswer> => {
      const started = Date.now();
      try {
        const content = await chatCompletion({
          apiKey,
          model,
          messages,
          maxTokens,
          timeoutMs,
          fetchImpl,
        });
        return { model, ok: true, content, ms: Date.now() - started };
      } catch (err) {
        return {
          model,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ms: Date.now() - started,
        };
      }
    }),
  );

  // allSettled never rejects for our mapper (it always resolves a PanelAnswer),
  // but guard the `rejected` branch anyway so a thrown non-Error can't escape.
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { model: models[i] ?? "unknown", ok: false, error: String(r.reason), ms: 0 },
  );
}

export interface SynthesizeParams {
  apiKey: string;
  prompt: string;
  answers: PanelAnswer[];
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Asks one model to compare the panel's answers. The instruction deliberately
 * tells it to SURFACE disagreement rather than smooth it into a bland average —
 * a single confident consensus is exactly what a second opinion is meant to break.
 */
export async function synthesize(params: SynthesizeParams): Promise<string> {
  const { apiKey, prompt, answers, model, maxTokens, timeoutMs, fetchImpl } = params;

  const ok = answers.filter((a) => a.ok);
  if (ok.length === 0) throw new Error("no successful answers to synthesize");

  const transcript = ok
    .map((a, i) => `### Expert ${i + 1} — ${a.model}\n${a.content}`)
    .join("\n\n");

  const system =
    "You are a careful aggregator comparing answers from several AI models to the same question. " +
    "Identify where they AGREE and, just as importantly, where they DISAGREE — name the conflict explicitly " +
    "instead of averaging it away. Then give a short, honest bottom line. Be concise.";

  const user =
    `Original question:\n${prompt}\n\n` +
    `Answers from the panel:\n\n${transcript}\n\n` +
    "Write: (1) Points of agreement, (2) Points of disagreement or divergence, (3) Bottom line.";

  return chatCompletion({
    apiKey,
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens: maxTokens ?? 1024,
    timeoutMs,
    fetchImpl,
  });
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
    lines.push(`## ${a.model} ${a.ok ? `(${a.ms}ms)` : "— FAILED"}`);
    lines.push(a.ok ? (a.content ?? "") : `> error: ${a.error}`);
    lines.push("");
  }

  if (synthesis) {
    lines.push("## 🔎 Synthesis");
    lines.push(synthesis);
    lines.push("");
  }

  const failed = answers.filter((a) => !a.ok).length;
  if (failed > 0) {
    lines.push(`_${failed} of ${answers.length} model(s) failed; the rest are shown above._`);
  }

  return lines.join("\n").trim();
}
