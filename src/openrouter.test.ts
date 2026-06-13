import { describe, it, expect } from "vitest";
import { chatCompletion } from "./openrouter.js";

const noSleep = async (): Promise<void> => {};

interface FakeResp {
  ok?: boolean;
  status?: number;
  json?: unknown;
  jsonThrows?: boolean;
  text?: string;
  abort?: boolean;
}

/** Returns a fetch that yields the queued responses in order; last one repeats. */
function fetchSeq(seq: FakeResp[]): { fetch: typeof fetch; calls: () => number } {
  let i = 0;
  const fn = (async () => {
    const r = seq[Math.min(i, seq.length - 1)] as FakeResp;
    i++;
    if (r.abort) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: "X",
      json: async () => {
        if (r.jsonThrows) throw new Error("bad json");
        return r.json ?? { choices: [{ message: { content: "hello" } }] };
      },
      text: async () => r.text ?? "",
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls: () => i };
}

const base = {
  apiKey: "k",
  model: "m/one",
  messages: [{ role: "user" as const, content: "hi" }],
  sleepImpl: noSleep,
};

describe("chatCompletion", () => {
  it("returns content and parses token usage", async () => {
    const { fetch } = fetchSeq([
      { json: { choices: [{ message: { content: " hi " } }], usage: { total_tokens: 42 } } },
    ]);
    const r = await chatCompletion({ ...base, fetchImpl: fetch });
    expect(r.content).toBe("hi");
    expect(r.usage?.totalTokens).toBe(42);
  });

  it("retries a transient 429 and then succeeds", async () => {
    const { fetch, calls } = fetchSeq([
      { ok: false, status: 429, text: "rate limited" },
      { json: { choices: [{ message: { content: "ok" } }] } },
    ]);
    const r = await chatCompletion({ ...base, fetchImpl: fetch, retries: 2 });
    expect(r.content).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("gives up after exhausting retries on a persistent 503", async () => {
    const { fetch, calls } = fetchSeq([{ ok: false, status: 503, text: "down" }]);
    await expect(chatCompletion({ ...base, fetchImpl: fetch, retries: 1 })).rejects.toThrow(/503/);
    expect(calls()).toBe(2); // 1 initial + 1 retry
  });

  it("does NOT retry a permanent 400", async () => {
    const { fetch, calls } = fetchSeq([{ ok: false, status: 400, text: "bad request" }]);
    await expect(chatCompletion({ ...base, fetchImpl: fetch, retries: 3 })).rejects.toThrow(/400/);
    expect(calls()).toBe(1);
  });

  it("surfaces an HTTP-200-with-error body as the provider error (no retry)", async () => {
    const { fetch, calls } = fetchSeq([{ json: { error: { message: "no endpoints for model" } } }]);
    await expect(chatCompletion({ ...base, fetchImpl: fetch, retries: 3 })).rejects.toThrow(
      /provider error: no endpoints/i,
    );
    expect(calls()).toBe(1);
  });

  it("rejects empty / whitespace-only content", async () => {
    const { fetch } = fetchSeq([{ json: { choices: [{ message: { content: "   " } }] } }]);
    await expect(chatCompletion({ ...base, fetchImpl: fetch })).rejects.toThrow(/no message content/i);
  });

  it("rejects a malformed JSON body", async () => {
    const { fetch } = fetchSeq([{ jsonThrows: true }]);
    await expect(chatCompletion({ ...base, fetchImpl: fetch })).rejects.toThrow(/not valid JSON/i);
  });

  it("does NOT retry a timeout — the budget is spent (even with retries > 0)", async () => {
    const { fetch, calls } = fetchSeq([{ abort: true }]);
    await expect(chatCompletion({ ...base, fetchImpl: fetch, retries: 3 })).rejects.toThrow(
      /timed out/i,
    );
    expect(calls()).toBe(1);
  });

  it("DOES retry a genuine network error (no response)", async () => {
    let i = 0;
    const flaky = (async () => {
      i++;
      if (i === 1) throw new TypeError("fetch failed"); // network blip, not an abort
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: { content: "recovered" } }] }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;
    const r = await chatCompletion({ ...base, fetchImpl: flaky, retries: 2 });
    expect(r.content).toBe("recovered");
    expect(i).toBe(2);
  });
});
