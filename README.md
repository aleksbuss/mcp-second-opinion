# mcp-second-opinion

[![CI](https://github.com/aleksbuss/mcp-second-opinion/actions/workflows/ci.yml/badge.svg)](https://github.com/aleksbuss/mcp-second-opinion/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)

**An [MCP](https://modelcontextprotocol.io) server that gets you a second opinion.** It asks the *same* question to a panel of LLMs from different providers — in parallel, through a single [OpenRouter](https://openrouter.ai) key — and hands back every answer side by side. Optionally it synthesizes them, and is told to **surface where the models disagree** instead of averaging it into a confident-sounding blur.

One model can be confidently wrong. A panel that's forced to disagree is much harder to fool — so give your agent (Claude Desktop, or any MCP client) the ability to check a claim against three minds before trusting one.

```
You → second_opinion("Is this SQL injection-safe?", synthesize: true)

  ## openai/gpt-4o-mini      → "Yes, parameterised — safe."
  ## anthropic/claude-3.5-haiku → "No — the ORDER BY clause is interpolated."
  ## google/gemini-2.5-flash → "Safe for the WHERE clause; ORDER BY is a risk."

  ## 🔎 Synthesis
  Disagreement: the ORDER BY interpolation. Two of three flag it. Bottom line: not safe.
```

## Why

- **Cross-provider by design.** OpenRouter proxies OpenAI / Anthropic / Google / Meta / … behind one OpenAI-compatible endpoint, so a real multi-provider panel needs only **one** API key.
- **Resilient by construction.** Each member runs with a per-attempt timeout, **bounded retries with backoff + jitter** on transient failures (429 / 5xx / network), and fast-fail on permanent ones (400/401/404). A slow or failing model is reported as one failed answer — it never sinks the batch. All covered by tests.
- **Bounded & honest about cost.** Fan-out is capped (concurrency limit + max panel size + dedup of repeated ids), and every answer reports its **token usage** with a running total — you can see what N opinions cost.
- **Disagreement is measured, not just described.** The answers are embedded and scored by pairwise cosine distance; when the panel is genuinely split (past a threshold), the synthesizer is told to *centre* the conflict instead of averaging it away. See below.

## Install

Requires Node ≥ 18 and an OpenRouter API key (free to create at <https://openrouter.ai/keys>).

```bash
git clone https://github.com/aleksbuss/mcp-second-opinion.git
cd mcp-second-opinion
npm install
npm run build
```

### Add it to Claude Desktop

Edit `claude_desktop_config.json` (Claude → Settings → Developer → Edit Config):

```jsonc
{
  "mcpServers": {
    "second-opinion": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-second-opinion/dist/index.js"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-..."
      }
    }
  }
}
```

Restart Claude Desktop; the `second_opinion` and `list_panel_models` tools appear.

## Tools

### `second_opinion`
| arg | type | notes |
| --- | --- | --- |
| `prompt` | string (required) | The question to put to the panel. |
| `models` | string[] (optional) | OpenRouter model ids (max 8, deduped). Omit to use the default panel. |
| `synthesize` | boolean (optional) | If true, a synthesizer model compares the answers. |
| `system` | string (optional) | System prompt sent to every model. |
| `max_tokens` | number (optional) | Max output tokens per model. Defaults to the server setting. |
| `temperature` | number 0–2 (optional) | Sampling temperature (0 = deterministic). Defaults to the server setting. |

Returns an error result to the client only when **every** model fails; a partial panel is still a useful answer.

### `list_panel_models`
Returns the configured default panel and how to override it. No arguments.

## Disagreement scoring

Whenever ≥2 models answer, the server embeds the answers (via OpenRouter's `/embeddings` — same key) and computes **pairwise cosine distance** to measure how far apart they actually are:

```
## ⚖ Disagreement: strong disagreement — flagged
Max pairwise distance 0.61 (anthropic/claude-3.5-haiku ↔ openai/gpt-4o-mini);
mean 0.44 across 3 models. (0 = identical, 1 = unrelated.)
```

When the max distance crosses the threshold (default **0.35**), the panel is *flagged* and the synthesizer is explicitly told to make the conflict the centre of its answer rather than paper over it. This is the same embedding-based disagreement detection → aggregator-marker pipeline as [Orchestra](https://github.com/aleksbuss/orchestra), in miniature.

Scoring is **best-effort**: if there are too few answers or the embedding call fails, the panel still returns — it just omits the score. Turn it off with `SECOND_OPINION_EMBEDDINGS=off`.

## Configuration (environment)

| var | required | default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | ✅ | — |
| `SECOND_OPINION_MODELS` | | `openai/gpt-4o-mini, anthropic/claude-3.5-haiku, google/gemini-2.5-flash-lite` |
| `SECOND_OPINION_SYNTH` | | `openai/gpt-4o-mini` |
| `SECOND_OPINION_TIMEOUT_MS` | | `60000` (per attempt) |
| `SECOND_OPINION_MAX_TOKENS` | | `1024` |
| `SECOND_OPINION_TEMPERATURE` | | `0.7` |
| `SECOND_OPINION_CONCURRENCY` | | `4` |
| `SECOND_OPINION_EMBEDDINGS` | | `on` (set `off` to disable disagreement scoring) |
| `SECOND_OPINION_EMBED_MODEL` | | `openai/text-embedding-3-small` |
| `SECOND_OPINION_DISAGREE_THRESHOLD` | | `0.35` |

Any model id on <https://openrouter.ai/models> works. Pick a cheap, fast panel — you're paying for N calls per question.

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (mocks fetch; no network, no key needed)
npm run build       # → dist/
npm run dev         # run from source via tsx
```

The logic is split so it's testable without a network or a key — `fetch` and `sleep` are injected:

- [`src/openrouter.ts`](src/openrouter.ts) — the HTTP client: chat + embeddings, retry/backoff, HTTP-200-with-error bodies, timeouts, token usage. ([tests](src/openrouter.test.ts))
- [`src/panel.ts`](src/panel.ts) — fan-out with bounded concurrency, dedup, the resilience invariant, and synthesis. ([tests](src/panel.test.ts))
- [`src/disagreement.ts`](src/disagreement.ts) — embedding-distance scoring (cosine math, pairwise aggregation), embedder injected. ([tests](src/disagreement.test.ts))
- [`src/config.ts`](src/config.ts) — pure config parsing (models, caps, env). ([tests](src/config.test.ts))
- [`src/handler.ts`](src/handler.ts) — the `second_opinion` flow (key check → fan-out → disagreement → synthesis → compose), with `fetch` and the embedder injected so the glue itself is tested, not just live-checked. ([tests](src/handler.test.ts))

104 tests, run on Node 18, 20 & 22 in CI. The disagreement maths is tested with a fake embedder, so CI needs no model and no key.

Engineering contracts and the failures that shaped them are written down in [`CLAUDE.md`](./CLAUDE.md) and [`POST_MORTEMS.md`](./POST_MORTEMS.md) — small project, but the same habit.

## Security & limitations

- **The panel's answers are unverified model output.** This tool returns raw text from third-party LLMs (and, on failure, truncated provider error bodies) straight into the caller's context. If an **agent** calls this autonomously on attacker-influenced input, treat the answers as *data, not instructions* — they are a prompt-injection surface, like any MCP tool that returns external content. The output is intentionally not wrapped in trust markers because the tool's whole purpose is to show you what the models said; the trust boundary is the caller's responsibility.
- **BYOK, and you pay per question × per model.** There is no spend cap — `max_tokens` bounds output length but not model choice. Keep the default panel cheap; don't point it at a panel of frontier models by accident.
- **Single-operator / local trust model.** Designed to run locally next to an MCP client (Claude Desktop) with your own key in the environment. The key is never logged.

## License

MIT © Aleksejs Buss
