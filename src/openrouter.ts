/**
 * Minimal OpenRouter chat-completions client.
 *
 * One backend, every provider: OpenRouter proxies OpenAI / Anthropic / Google /
 * Meta / etc. behind a single OpenAI-compatible endpoint and one API key. That is
 * what lets this server fan a prompt out to a cross-provider panel without the
 * caller juggling three separate keys.
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Per-request wall-clock budget. The request is aborted when it elapses. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Calls one model and returns its text. Throws on transport errors, timeouts,
 * or non-2xx responses (with a short body snippet for diagnosis). Callers that
 * fan out to many models should catch per-call so one failure can't sink the batch.
 */
export async function chatCompletion(opts: ChatOptions): Promise<string> {
  const {
    apiKey,
    model,
    messages,
    maxTokens = 1024,
    temperature = 0.7,
    timeoutMs = 60_000,
    fetchImpl = fetch,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Optional attribution headers OpenRouter recommends for app traffic.
        "HTTP-Referer": "https://github.com/aleksbuss/mcp-second-opinion",
        "X-Title": "mcp-second-opinion",
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    throw new Error(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("response contained no message content");
  }
  return content.trim();
}
