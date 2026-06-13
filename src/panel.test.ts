import { describe, it, expect } from "vitest";
import { askPanel, synthesize, formatResult, composeResult, type PanelAnswer } from "./panel.js";

const noSleep = async (): Promise<void> => {};

type ModelResult = {
  ok?: boolean;
  status?: number;
  content?: string;
  textBody?: string;
  abort?: boolean;
  totalTokens?: number;
};

/** A fake fetch routed by the request body's `model` field. */
function fakeFetch(route: (model: string) => ModelResult): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    const r = route(body.model);
    if (r.abort) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: "OK",
      json: async () => ({
        choices: [{ message: { content: r.content ?? `answer from ${body.model}` } }],
        ...(r.totalTokens ? { usage: { total_tokens: r.totalTokens } } : {}),
      }),
      text: async () => r.textBody ?? "",
    } as Response;
  }) as unknown as typeof fetch;
}

// retries:0 + noSleep keeps the (now-retryable) failure tests fast & deterministic.
const base = { apiKey: "k", prompt: "Is the earth round?", timeoutMs: 1000, retries: 0, sleepImpl: noSleep };

describe("askPanel", () => {
  it("returns one answer per model, all successful, with token usage", async () => {
    const answers = await askPanel({
      ...base,
      models: ["a/one", "b/two", "c/three"],
      fetchImpl: fakeFetch(() => ({ ok: true, totalTokens: 11 })),
    });
    expect(answers).toHaveLength(3);
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(answers.map((a) => a.model)).toEqual(["a/one", "b/two", "c/three"]);
    expect(answers[0]!.tokens).toBe(11);
  });

  it("a single failing model does NOT sink the batch (resilience invariant)", async () => {
    const answers = await askPanel({
      ...base,
      models: ["a/one", "b/two", "c/three"],
      fetchImpl: fakeFetch((m) =>
        m === "b/two" ? { ok: false, status: 429, textBody: "rate limited" } : { ok: true },
      ),
    });
    expect(answers[0]!.ok).toBe(true);
    expect(answers[1]!.ok).toBe(false);
    expect(answers[1]!.error).toContain("429");
    expect(answers[2]!.ok).toBe(true);
  });

  it("records a timeout as a failed answer, not a thrown batch", async () => {
    const answers = await askPanel({
      ...base,
      models: ["slow/model", "fast/model"],
      fetchImpl: fakeFetch((m) => (m === "slow/model" ? { abort: true } : { ok: true })),
    });
    expect(answers[0]!.ok).toBe(false);
    expect(answers[0]!.error).toMatch(/timed out/i);
    expect(answers[1]!.ok).toBe(true);
  });

  it("dedupes models so the same id is queried once", async () => {
    let calls = 0;
    const counting = (async (_u: string, init?: RequestInit) => {
      calls++;
      JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    const answers = await askPanel({
      ...base,
      models: ["a/one", "a/one", "b/two"],
      fetchImpl: counting,
    });
    expect(answers).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("respects the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tracking = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    await askPanel({
      ...base,
      models: ["a", "b", "c", "d", "e"],
      concurrency: 2,
      fetchImpl: tracking,
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
  });

  it("forwards max_tokens and temperature to the request", async () => {
    let sentBody: { max_tokens?: number; temperature?: number } = {};
    const spy = (async (_u: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    await askPanel({ ...base, models: ["a/one"], maxTokens: 256, temperature: 0, fetchImpl: spy });
    expect(sentBody.max_tokens).toBe(256);
    expect(sentBody.temperature).toBe(0);
  });

  it("includes a system prompt for every model when provided", async () => {
    let seenSystem = false;
    const spy = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
      if (body.messages[0]?.role === "system") seenSystem = true;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    await askPanel({ ...base, models: ["a/one"], system: "Be terse.", fetchImpl: spy });
    expect(seenSystem).toBe(true);
  });
});

describe("synthesize", () => {
  const answers: PanelAnswer[] = [
    { model: "a/one", ok: true, content: "Yes, it is an oblate spheroid.", ms: 10 },
    { model: "b/two", ok: false, error: "HTTP 500", ms: 5 },
  ];

  it("synthesizes from successful answers only", async () => {
    const out = await synthesize({
      apiKey: "k",
      prompt: base.prompt,
      answers,
      model: "synth/model",
      sleepImpl: noSleep,
      fetchImpl: fakeFetch(() => ({ content: "Agreement: round. Bottom line: yes." })),
    });
    expect(out).toContain("Agreement");
  });

  it("throws when there are no successful answers", async () => {
    await expect(
      synthesize({
        apiKey: "k",
        prompt: base.prompt,
        answers: [{ model: "x", ok: false, error: "boom", ms: 1 }],
        model: "synth/model",
        sleepImpl: noSleep,
        fetchImpl: fakeFetch(() => ({ ok: true })),
      }),
    ).rejects.toThrow(/no successful answers/i);
  });
});

describe("formatResult", () => {
  it("renders answers (with tokens), marks failures, appends synthesis and a footer", () => {
    const out = formatResult(
      "Q?",
      [
        { model: "a/one", ok: true, content: "Answer A", tokens: 30, ms: 12 },
        { model: "b/two", ok: false, error: "HTTP 429", ms: 8 },
      ],
      "Synthesis text",
    );
    expect(out).toContain("## a/one (12ms, 30 tok)");
    expect(out).toContain("Answer A");
    expect(out).toContain("## b/two — FAILED");
    expect(out).toContain("HTTP 429");
    expect(out).toContain("## 🔎 Synthesis");
    expect(out).toContain("30 tokens total");
    expect(out).toContain("1 of 2 model(s) failed");
  });
});

describe("composeResult", () => {
  const ok: PanelAnswer = { model: "a", ok: true, content: "yes", ms: 1 };
  const bad: PanelAnswer = { model: "b", ok: false, error: "x", ms: 1 };

  it("is not an error when at least one model succeeded", () => {
    expect(composeResult("q", [ok, bad]).isError).toBe(false);
  });
  it("is an error when EVERY model failed", () => {
    expect(composeResult("q", [bad, { ...bad, model: "c" }]).isError).toBe(true);
  });
  it("is an error when the panel is empty", () => {
    expect(composeResult("q", []).isError).toBe(true);
  });
  it("appends the dropped-models note", () => {
    const { text } = composeResult("q", [ok], { dropped: 2, maxModels: 8 });
    expect(text).toContain("2 duplicate/excess model(s) were dropped");
    expect(text).toContain("capped at 8");
  });
});
