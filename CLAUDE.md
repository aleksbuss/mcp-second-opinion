# mcp-second-opinion — engineering notes

## For AI assistants working in this repo
You are working on a small, production-quality **MCP server** (TypeScript, strict). Keep it small. Match the existing style: pure, fetch/sleep-injectable logic; explicit transient-vs-permanent error handling; a test for every behaviour. Read [`POST_MORTEMS.md`](./POST_MORTEMS.md) before touching the HTTP client or the fan-out — both entries there are live regressions waiting to happen again.

## Stack
TypeScript (strict, `NodeNext` ESM) · `@modelcontextprotocol/sdk` (high-level `McpServer.registerTool` + `StdioServerTransport`) · **zod pinned to v3** (the SDK is built against it — see PM #2) · Vitest · GitHub Actions CI (Node 18, 20 & 22 — the matrix matches the `engines` claim).

## Architecture — one job per file
```
src/openrouter.ts   HTTP client: chat (retries, error taxonomy, usage) + embeddings
src/panel.ts        Fan-out (bounded concurrency + dedup) + synthesis + Markdown render
src/disagreement.ts Embedding-distance scoring (cosine, pairwise) — embedder injected
src/embedder.ts     Adapts openrouter.embed() to the Embedder interface
src/config.ts       Pure config parsing: model lists, caps, env coercion
src/handler.ts      The second_opinion flow (key check → fan-out → score → synth → compose), fetch + embedder injected so the glue is unit-tested
src/index.ts        MCP server: tool registration, arg schemas, env → config, stdio (the only file that reads process.env / the global fetch)
```
The request flow: `index.ts` (tool call, env → config) → `handler.runSecondOpinion` → `config` (normalise models) → `panel.askPanel` (fan out, bounded) → `openrouter.chatCompletion` (per model, retried) → best-effort `disagreement.scoreDisagreement` → optional `panel.synthesize` → `panel.composeResult` (Markdown + isError back to the client). The handler takes `fetch`/`sleep`/`embedder` as injected deps, so the whole flow is tested without a network in `handler.test.ts`.

## Contracts (don't break these)

1. **Resilience invariant — one member failing must never sink the batch.** `askPanel` wraps every model so a failure becomes a recorded `PanelAnswer{ ok: false }`, not a thrown batch. The tool returns `isError: true` only when **every** model fails. Regression: `panel.test.ts` "a single failing model does NOT sink the batch".

2. **Error taxonomy — transient vs permanent (see PM #3).** `openrouter.ts` classifies failures: `429/5xx`/network/timeout → `TransientError` (retried with backoff+jitter); `4xx`/bad-body/HTTP-200-with-error → `PermanentError` (fail fast). Never retry a permanent error; never give up on a transient one without exhausting `retries`.

3. **Everything is injectable for tests.** `fetch` and `sleep` are parameters (`fetchImpl`, `sleepImpl`), so the whole suite runs with **no network and no API key**. Any new code that does I/O or waits MUST accept an injected impl, or it can't be tested. Live behaviour is checked separately, by hand, with a real key (see contract 4).

4. **Hardcoded external ids must be live-verified (see PM #1).** Mock tests can't catch a wrong-but-well-formed model id. Before changing `DEFAULT_MODELS`, confirm each id against `GET https://openrouter.ai/api/v1/models`. Defaults must work on a zero-config first run.

5. **stdout is the JSON-RPC channel — keep it clean.** All logging goes to `console.error` (stderr). A stray `console.log` corrupts the MCP protocol and the client silently breaks.

6. **Fan-out is bounded by construction.** Concurrency cap (`concurrency`), panel-size cap (`MAX_MODELS = 8`), and dedup are not optional niceties — they stop the tool from firing unbounded paid calls. Keep them when refactoring.

7. **Panel output is untrusted, and that's a deliberate, documented choice.** Answers are raw third-party LLM text returned to the caller. We do NOT wrap them in trust markers — the tool's purpose is to surface what the models said, and markers would fight that. The trust boundary is the caller's. If you ever make this tool *act* on the answers (not just return them), revisit this and add untrusted-content handling. See README "Security & limitations".

8. **Disagreement scoring is best-effort and the embedder is injected.** `scoreDisagreement` returns `null` (never throws) on <2 answers or an embedding failure — a missing score must never slow or sink the panel. The `Embedder` is a parameter (`(texts) => Promise<number[][]>`), so the cosine maths is unit-tested with preset vectors — no model, no network, no key in CI. The real embedder rides OpenRouter's `/embeddings` (same key — `/embeddings` exists despite OpenRouter's chat-first reputation; PM #5). To swap in a local or API embedder, implement `Embedder` and wire it in `index.ts` — the maths doesn't change.

## How to extend

- **Add a tool:** `server.registerTool(name, { title, description, inputSchema }, handler)` in `index.ts`. Schema is a zod **v3** raw shape. Handler returns `{ content: [{ type: "text", text }], isError? }`.
- **Add a provider:** there's nothing to add — every provider rides OpenRouter through `chatCompletion`. New behaviour belongs in `openrouter.ts` (transport) or `panel.ts` (orchestration), each with tests.
- **Any new failure mode you hit:** add a `POST_MORTEMS.md` entry (symptom / detection / root cause / fix / lesson) and a regression test. That habit is the point of this repo.

## Commands
```
npm run typecheck   # tsc --noEmit
npm test            # vitest — no network, no key
npm run build       # → dist/  (also runs on prepack before publish)
npm run dev         # run from source via tsx
```
