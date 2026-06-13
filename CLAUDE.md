# mcp-second-opinion — engineering notes

## For AI assistants working in this repo
You are working on a small, production-quality **MCP server** (TypeScript, strict). Keep it small. Match the existing style: pure, fetch/sleep-injectable logic; explicit transient-vs-permanent error handling; a test for every behaviour. Read [`POST_MORTEMS.md`](./POST_MORTEMS.md) before touching the HTTP client or the fan-out — both entries there are live regressions waiting to happen again.

## Stack
TypeScript (strict, `NodeNext` ESM) · `@modelcontextprotocol/sdk` (high-level `McpServer.registerTool` + `StdioServerTransport`) · **zod pinned to v3** (the SDK is built against it — see PM #2) · Vitest · GitHub Actions CI (Node 20 & 22).

## Architecture — three files, one job each
```
src/openrouter.ts  HTTP client: one model call, retries, error taxonomy, token usage
src/panel.ts       Fan-out (bounded concurrency + dedup) + synthesis + Markdown render
src/config.ts      Pure config parsing: model lists, caps, env coercion
src/index.ts       MCP server: tool registration, arg schemas, env wiring (the only impure file)
```
The request flow: `index.ts` (tool call) → `config` (normalise models) → `panel.askPanel` (fan out, bounded) → `openrouter.chatCompletion` (per model, retried) → `panel.formatResult` (Markdown back to the client).

## Contracts (don't break these)

1. **Resilience invariant — one member failing must never sink the batch.** `askPanel` wraps every model so a failure becomes a recorded `PanelAnswer{ ok: false }`, not a thrown batch. The tool returns `isError: true` only when **every** model fails. Regression: `panel.test.ts` "a single failing model does NOT sink the batch".

2. **Error taxonomy — transient vs permanent (see PM #3).** `openrouter.ts` classifies failures: `429/5xx`/network/timeout → `TransientError` (retried with backoff+jitter); `4xx`/bad-body/HTTP-200-with-error → `PermanentError` (fail fast). Never retry a permanent error; never give up on a transient one without exhausting `retries`.

3. **Everything is injectable for tests.** `fetch` and `sleep` are parameters (`fetchImpl`, `sleepImpl`), so the whole suite runs with **no network and no API key**. Any new code that does I/O or waits MUST accept an injected impl, or it can't be tested. Live behaviour is checked separately, by hand, with a real key (see contract 4).

4. **Hardcoded external ids must be live-verified (see PM #1).** Mock tests can't catch a wrong-but-well-formed model id. Before changing `DEFAULT_MODELS`, confirm each id against `GET https://openrouter.ai/api/v1/models`. Defaults must work on a zero-config first run.

5. **stdout is the JSON-RPC channel — keep it clean.** All logging goes to `console.error` (stderr). A stray `console.log` corrupts the MCP protocol and the client silently breaks.

6. **Fan-out is bounded by construction.** Concurrency cap (`concurrency`), panel-size cap (`MAX_MODELS = 8`), and dedup are not optional niceties — they stop the tool from firing unbounded paid calls. Keep them when refactoring.

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
