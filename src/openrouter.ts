/**
 * Minimal, resilient OpenRouter chat-completions client.
 *
 * One backend, every provider: OpenRouter proxies OpenAI / Anthropic / Google /
 * Meta / etc. behind a single OpenAI-compatible endpoint and one API key. That is
 * what lets this server fan a prompt out to a cross-provider panel without the
 * caller juggling separate keys.
 *
 * Resilience built in here (not bolted on by callers):
 *   - transient failures (429 / 5xx / network / timeout) are retried with
 *     exponential backoff + jitter; permanent ones (400/401/403/404, bad body)
 *     fail fast;
 *   - HTTP-200-with-error-body (OpenRouter does this) is detected and surfaced
 *     as the real provider error, not a vague "no content".
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Statuses worth retrying — overload / rate-limit / gateway, never client errors. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResult {
  content: string;
  usage?: TokenUsage;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Per-attempt wall-clock budget. The request is aborted when it elapses. */
  timeoutMs?: number;
  /** Number of *additional* attempts after the first (default 2). */
  retries?: number;
  /** Base backoff in ms (default 300); actual wait = base * 2^attempt + jitter. */
  backoffBaseMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so backoff doesn't actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** A transient failure — safe to retry. */
class TransientError extends Error {}
/** A permanent failure — retrying won't help. */
class PermanentError extends Error {}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const usage: TokenUsage = {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  };
  return usage.totalTokens ?? usage.promptTokens ?? usage.completionTokens
    ? usage
    : undefined;
}

async function attemptOnce(opts: Required<Pick<ChatOptions, "apiKey" | "model" | "messages">> & {
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await opts.fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/aleksbuss/mcp-second-opinion",
        "X-Title": "mcp-second-opinion",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure or our own abort timeout — both transient.
    if (err instanceof Error && err.name === "AbortError") {
      throw new TransientError(`timed out after ${opts.timeoutMs}ms`);
    }
    throw new TransientError(
      `request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const msg = `HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`;
    throw RETRYABLE_STATUS.has(res.status) ? new TransientError(msg) : new PermanentError(msg);
  }

  let data: {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; code?: number | string };
    usage?: unknown;
  };
  try {
    data = await res.json();
  } catch {
    throw new PermanentError("response was not valid JSON");
  }

  // OpenRouter can return HTTP 200 with an error envelope.
  if (data.error) {
    throw new PermanentError(`provider error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new PermanentError("response contained no message content");
  }
  return { content: content.trim(), usage: parseUsage(data.usage) };
}

/**
 * Calls one model with bounded retries. Returns its text + token usage, or throws
 * once retries are exhausted (or immediately on a permanent error).
 */
export async function chatCompletion(opts: ChatOptions): Promise<ChatResult> {
  const retries = opts.retries ?? 2;
  const backoffBaseMs = opts.backoffBaseMs ?? 300;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const fixed = {
    apiKey: opts.apiKey,
    model: opts.model,
    messages: opts.messages,
    maxTokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.7,
    timeoutMs: opts.timeoutMs ?? 60_000,
    fetchImpl: opts.fetchImpl ?? fetch,
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await attemptOnce(fixed);
    } catch (err) {
      lastErr = err;
      if (err instanceof PermanentError || attempt === retries) break;
      // TransientError → back off with jitter and retry.
      const wait = backoffBaseMs * 2 ** attempt + Math.floor(Math.random() * backoffBaseMs);
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
