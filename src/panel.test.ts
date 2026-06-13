import { describe, it, expect } from "vitest";
import { askPanel, synthesize, formatResult, type PanelAnswer } from "./panel.js";

/**
 * A fake `fetch` that routes by the `model` field in the request body, so each
 * test can make individual panel members succeed, fail, or hang independently.
 */
type ModelResult = {
  ok?: boolean;
  status?: number;
  content?: string;
  textBody?: string;
  abort?: boolean;
};

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
      }),
      text: async () => r.textBody ?? "",
    } as Response;
  }) as unknown as typeof fetch;
}

const base = {
  apiKey: "test-key",
  prompt: "Is the earth round?",
  timeoutMs: 1000,
};

describe("askPanel", () => {
  it("returns one answer per model, all successful", async () => {
    const answers = await askPanel({
      ...base,
      models: ["a/one", "b/two", "c/three"],
      fetchImpl: fakeFetch(() => ({ ok: true })),
    });
    expect(answers).toHaveLength(3);
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(answers.map((a) => a.model)).toEqual(["a/one", "b/two", "c/three"]);
    expect(answers[0]!.content).toContain("a/one");
  });

  it("a single failing model does NOT sink the batch (resilience invariant)", async () => {
    const answers = await askPanel({
      ...base,
      models: ["a/one", "b/two", "c/three"],
      fetchImpl: fakeFetch((m) =>
        m === "b/two" ? { ok: false, status: 429, textBody: "rate limited" } : { ok: true },
      ),
    });
    expect(answers).toHaveLength(3);
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

  it("includes a system prompt for every model when provided", async () => {
    let seenSystem = false;
    const spyFetch = (async (_u: string, init?: RequestInit) => {
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

    await askPanel({ ...base, models: ["a/one"], system: "Be terse.", fetchImpl: spyFetch });
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
        fetchImpl: fakeFetch(() => ({ ok: true })),
      }),
    ).rejects.toThrow(/no successful answers/i);
  });
});

describe("formatResult", () => {
  it("renders each answer, marks failures, and appends synthesis", () => {
    const out = formatResult(
      "Q?",
      [
        { model: "a/one", ok: true, content: "Answer A", ms: 12 },
        { model: "b/two", ok: false, error: "HTTP 429", ms: 8 },
      ],
      "Synthesis text",
    );
    expect(out).toContain("## a/one (12ms)");
    expect(out).toContain("Answer A");
    expect(out).toContain("## b/two — FAILED");
    expect(out).toContain("HTTP 429");
    expect(out).toContain("## 🔎 Synthesis");
    expect(out).toContain("1 of 2 model(s) failed");
  });
});
