import { describe, it, expect } from "vitest";
import { runSecondOpinion, type SecondOpinionConfig } from "./handler.js";
import type { Embedder } from "./disagreement.js";

const noSleep = async (): Promise<void> => {};

const baseConfig: SecondOpinionConfig = {
  apiKey: "k",
  defaultPanel: ["a/one", "b/two"],
  synthModel: "synth/model",
  timeoutMs: 1000,
  defaultMaxTokens: 256,
  defaultTemperature: 0.7,
  concurrency: 4,
  embeddingsOn: true,
  disagreeThreshold: 0.35,
  maxModels: 8,
};

type Route = { ok?: boolean; status?: number; content?: string; textBody?: string };

/** Fake fetch for chat completions, routed by the request body's `model`. */
function fakeFetch(route: (model: string) => Route): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    const r = route(body.model);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: "OK",
      json: async () => ({
        choices: [{ message: { content: r.content ?? `answer from ${body.model}` } }],
        usage: { total_tokens: 7 },
      }),
      text: async () => r.textBody ?? "",
    } as Response;
  }) as unknown as typeof fetch;
}

/** Fake embedder mapping each answer's text to a preset vector (default orthogonal-safe [1,0]). */
const embedderFrom =
  (map: Record<string, number[]>): Embedder =>
  async (texts) =>
    texts.map((t) => map[t] ?? [1, 0]);

const deps = (fetchImpl: typeof fetch, embedder: Embedder) => ({ embedder, fetchImpl, sleepImpl: noSleep });

describe("runSecondOpinion (handler glue)", () => {
  it("returns the key-missing error and makes no network call when no key is set", async () => {
    let fetched = false;
    const spy = (async () => {
      fetched = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    const r = await runSecondOpinion({ prompt: "hi" }, { ...baseConfig, apiKey: "" }, { embedder: embedderFrom({}), fetchImpl: spy });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("OPENROUTER_API_KEY is not set");
    expect(fetched).toBe(false); // short-circuits before fanning out
  });

  it("queries the default panel and renders every answer", async () => {
    const r = await runSecondOpinion(
      { prompt: "Is the earth round?" },
      { ...baseConfig, embeddingsOn: false },
      deps(fakeFetch((m) => ({ content: `${m} says yes` })), embedderFrom({})),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("## a/one");
    expect(r.text).toContain("## b/two");
    expect(r.text).toContain("a/one says yes");
  });

  it("uses caller-supplied models over the default panel", async () => {
    const r = await runSecondOpinion(
      { prompt: "q", models: ["x/custom"] },
      { ...baseConfig, embeddingsOn: false },
      deps(fakeFetch((m) => ({ content: `${m}!` })), embedderFrom({})),
    );
    expect(r.text).toContain("## x/custom");
    expect(r.text).not.toContain("a/one");
  });

  it("falls back to the default panel when models are only whitespace (schema min(1) doesn't catch it)", async () => {
    const r = await runSecondOpinion(
      { prompt: "q", models: ["   ", ""] },
      { ...baseConfig, embeddingsOn: false },
      deps(fakeFetch((m) => ({ content: `${m}!` })), embedderFrom({})),
    );
    expect(r.text).toContain("## a/one"); // default panel queried, not "0 models"
  });

  it("flags isError only when every model fails", async () => {
    const r = await runSecondOpinion(
      { prompt: "q" },
      { ...baseConfig, embeddingsOn: false },
      deps(fakeFetch(() => ({ ok: false, status: 500, textBody: "boom" })), embedderFrom({})),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("FAILED");
  });

  it("keeps a partial panel (one model down) as a non-error result", async () => {
    const r = await runSecondOpinion(
      { prompt: "q" },
      { ...baseConfig, embeddingsOn: false },
      deps(
        fakeFetch((m) => (m === "b/two" ? { ok: false, status: 404, textBody: "nope" } : { content: "ok" })),
        embedderFrom({}),
      ),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("## a/one");
    expect(r.text).toContain("## b/two — FAILED");
  });

  it("applies server defaults for max_tokens/temperature when the call omits them", async () => {
    let sent: { max_tokens?: number; temperature?: number } = {};
    const spy = (async (_u: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "x" } }] }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;
    await runSecondOpinion(
      { prompt: "q", models: ["a/one"] },
      { ...baseConfig, embeddingsOn: false, defaultMaxTokens: 333, defaultTemperature: 0.1 },
      { embedder: embedderFrom({}), fetchImpl: spy, sleepImpl: noSleep },
    );
    expect(sent.max_tokens).toBe(333);
    expect(sent.temperature).toBe(0.1);
  });

  it("scores disagreement and flags a divided panel", async () => {
    const r = await runSecondOpinion(
      { prompt: "q" },
      baseConfig,
      deps(
        fakeFetch((m) => ({ content: m === "a/one" ? "YES" : "NO" })),
        embedderFrom({ YES: [1, 0], NO: [0, 1] }), // orthogonal → max distance 1 → flagged
      ),
    );
    expect(r.text).toContain("⚖ Disagreement");
    expect(r.text).toContain("flagged");
  });

  it("omits disagreement scoring when disabled", async () => {
    const r = await runSecondOpinion(
      { prompt: "q" },
      { ...baseConfig, embeddingsOn: false },
      deps(fakeFetch(() => ({ content: "x" })), embedderFrom({ x: [1, 0] })),
    );
    expect(r.text).not.toContain("⚖ Disagreement");
  });

  it("survives an embedder failure (best-effort scoring never sinks the panel)", async () => {
    const boom: Embedder = async () => {
      throw new Error("embed down");
    };
    const r = await runSecondOpinion({ prompt: "q" }, baseConfig, deps(fakeFetch(() => ({ content: "x" })), boom));
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("⚖ Disagreement");
    expect(r.text).toContain("## a/one");
  });

  it("synthesizes and, when flagged divergent, tells the synthesizer to centre the conflict", async () => {
    let synthSystem = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      if (body.model === "synth/model") {
        synthSystem = body.messages[0]!.content;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ choices: [{ message: { content: "SYNTH OUTPUT" } }] }),
          text: async () => "",
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          choices: [{ message: { content: body.model === "a/one" ? "YES" : "NO" } }],
          usage: { total_tokens: 5 },
        }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    const r = await runSecondOpinion(
      { prompt: "q", synthesize: true },
      baseConfig,
      { embedder: embedderFrom({ YES: [1, 0], NO: [0, 1] }), fetchImpl, sleepImpl: noSleep },
    );
    expect(r.text).toContain("🔎 Synthesis");
    expect(r.text).toContain("SYNTH OUTPUT");
    expect(synthSystem).toContain("divergent"); // the flag fed through to the synthesizer
  });

  it("degrades a failed synthesis to a note without failing the whole result", async () => {
    const r = await runSecondOpinion(
      { prompt: "q", synthesize: true },
      { ...baseConfig, embeddingsOn: false },
      deps(
        fakeFetch((m) => (m === "synth/model" ? { ok: false, status: 500, textBody: "synth boom" } : { content: "ok" })),
        embedderFrom({}),
      ),
    );
    expect(r.isError).toBe(false); // the panel itself succeeded
    expect(r.text).toContain("synthesis failed");
  });

  it("caps an over-large default panel and notes the dropped models", async () => {
    const r = await runSecondOpinion(
      { prompt: "q" },
      { ...baseConfig, embeddingsOn: false, maxModels: 2, defaultPanel: ["a/one", "b/two", "c/three", "d/four"] },
      deps(fakeFetch(() => ({ content: "ok" })), embedderFrom({})),
    );
    expect(r.text).toContain("dropped");
    expect(r.text).toContain("capped at 2");
    expect(r.text).toContain("## a/one");
    expect(r.text).not.toContain("## c/three"); // only the first 2 queried
  });
});
