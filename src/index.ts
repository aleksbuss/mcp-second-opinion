#!/usr/bin/env node
/**
 * mcp-second-opinion — an MCP server that asks a panel of LLMs (via OpenRouter)
 * the same question in parallel and returns every answer side by side, with an
 * optional synthesis that surfaces where the models disagree.
 *
 * Config (environment):
 *   OPENROUTER_API_KEY         required — your OpenRouter key (BYOK)
 *   SECOND_OPINION_MODELS      optional — comma-separated default panel
 *   SECOND_OPINION_SYNTH       optional — model used for synthesis
 *   SECOND_OPINION_TIMEOUT_MS  optional — per-attempt timeout (default 60000)
 *   SECOND_OPINION_MAX_TOKENS  optional — max output tokens per model (default 1024)
 *   SECOND_OPINION_TEMPERATURE optional — sampling temperature 0..2 (default 0.7)
 *   SECOND_OPINION_CONCURRENCY optional — max models queried at once (default 4)
 *   SECOND_OPINION_EMBEDDINGS  optional — disagreement scoring on/off (default on)
 *   SECOND_OPINION_EMBED_MODEL optional — embeddings model (default text-embedding-3-small)
 *   SECOND_OPINION_DISAGREE_THRESHOLD optional — flag distance 0..1 (default 0.35)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askPanel, synthesize, composeResult } from "./panel.js";
import {
  DEFAULT_SYNTH,
  MAX_MODELS,
  parseBoolEnv,
  parseIntEnv,
  parseModels,
  parseTempEnv,
  parseThresholdEnv,
  resolveModels,
} from "./config.js";
import { scoreDisagreement, DEFAULT_DISAGREE_THRESHOLD } from "./disagreement.js";
import { makeOpenRouterEmbedder, DEFAULT_EMBED_MODEL } from "./embedder.js";

// Trim — keys pasted/sourced from a file commonly carry a trailing newline,
// which would otherwise corrupt the Authorization header and 401 every call.
const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
const defaultPanel = parseModels(process.env.SECOND_OPINION_MODELS);
const synthModel = process.env.SECOND_OPINION_SYNTH?.trim() || DEFAULT_SYNTH;
const timeoutMs = parseIntEnv(process.env.SECOND_OPINION_TIMEOUT_MS, 60_000);
const defaultMaxTokens = parseIntEnv(process.env.SECOND_OPINION_MAX_TOKENS, 1024);
const defaultTemperature = parseTempEnv(process.env.SECOND_OPINION_TEMPERATURE, 0.7);
const concurrency = parseIntEnv(process.env.SECOND_OPINION_CONCURRENCY, 4);
const embeddingsOn = parseBoolEnv(process.env.SECOND_OPINION_EMBEDDINGS, true);
const embedModel = process.env.SECOND_OPINION_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
const disagreeThreshold = parseThresholdEnv(
  process.env.SECOND_OPINION_DISAGREE_THRESHOLD,
  DEFAULT_DISAGREE_THRESHOLD,
);

const server = new McpServer({ name: "mcp-second-opinion", version: "0.3.2" });

const keyMissing = () => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: "OPENROUTER_API_KEY is not set. Add it to the server's environment (get a key at https://openrouter.ai/keys).",
    },
  ],
});

server.registerTool(
  "second_opinion",
  {
    title: "Second opinion from a panel of LLMs",
    description:
      "Ask the SAME question to several LLMs from different providers (via OpenRouter) in parallel and " +
      "get every answer side by side. Optionally synthesize them into one view that surfaces agreement " +
      "AND disagreement. Use this to sanity-check a claim, catch a single model's blind spot, or get a " +
      "genuine second opinion before trusting one answer.",
    inputSchema: {
      prompt: z.string().min(1).max(50_000).describe("The question to put to the panel."),
      models: z
        .array(z.string().min(1))
        .max(MAX_MODELS)
        .optional()
        .describe(
          `OpenRouter model ids to query (e.g. 'openai/gpt-4o-mini'). Max ${MAX_MODELS}. Omit to use the default panel.`,
        ),
      synthesize: z
        .boolean()
        .optional()
        .describe(
          "If true, a synthesizer model compares the answers and reports where they agree and disagree.",
        ),
      system: z
        .string()
        .max(20_000)
        .optional()
        .describe("Optional system prompt sent to every model in the panel."),
      max_tokens: z
        .number()
        .int()
        .positive()
        .max(32_000)
        .optional()
        .describe("Max output tokens per model. Defaults to the server setting."),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe("Sampling temperature (0 = deterministic). Defaults to the server setting."),
    },
  },
  async (args) => {
    if (!apiKey) return keyMissing();

    // resolveModels falls back to the default panel if `models` is omitted OR
    // normalises to empty (e.g. only whitespace ids slipped past the schema).
    const { models, dropped } = resolveModels(args.models, defaultPanel);

    const answers = await askPanel({
      apiKey,
      prompt: args.prompt,
      models,
      system: args.system,
      maxTokens: args.max_tokens ?? defaultMaxTokens,
      temperature: args.temperature ?? defaultTemperature,
      timeoutMs,
      concurrency,
    });

    // Best-effort disagreement score: embed the successful answers and measure how
    // far apart they are. Never throws (returns null on <2 answers or embed failure),
    // so a missing score can't slow or sink the panel.
    const okForScoring = answers
      .filter((a) => a.ok && a.content)
      .map((a) => ({ model: a.model, content: a.content as string }));
    const disagreement =
      embeddingsOn && okForScoring.length >= 2
        ? await scoreDisagreement(
            okForScoring,
            makeOpenRouterEmbedder(apiKey, embedModel, timeoutMs),
            disagreeThreshold,
          )
        : null;

    let synthesis: string | undefined;
    if (args.synthesize && answers.some((a) => a.ok)) {
      try {
        synthesis = await synthesize({
          apiKey,
          prompt: args.prompt,
          answers,
          model: synthModel,
          // When the panel is flagged as divided, tell the synthesizer to centre the conflict.
          emphasizeConflict: disagreement?.flagged ?? false,
          timeoutMs,
        });
      } catch (err) {
        synthesis = `_(synthesis failed: ${err instanceof Error ? err.message : String(err)})_`;
      }
    }

    const { text, isError } = composeResult(args.prompt, answers, {
      synthesis,
      disagreement,
      dropped,
      maxModels: MAX_MODELS,
    });
    return { isError, content: [{ type: "text" as const, text }] };
  },
);

server.registerTool(
  "list_panel_models",
  {
    title: "List the configured default panel",
    description:
      "Returns the models the panel queries by default and how to override them. No arguments.",
    inputSchema: {},
  },
  async () => {
    const text = [
      "Default panel (override per-call with the `models` argument, or globally with SECOND_OPINION_MODELS):",
      ...defaultPanel.map((m) => `  • ${m}`),
      "",
      `Synthesizer model (SECOND_OPINION_SYNTH): ${synthModel}`,
      `Per-attempt timeout: ${timeoutMs}ms · max tokens: ${defaultMaxTokens} · temperature: ${defaultTemperature} · concurrency: ${concurrency}`,
      `Disagreement scoring: ${embeddingsOn ? "on" : "off"} · embed model: ${embedModel} · flag threshold: ${disagreeThreshold}`,
      `Panel size cap: ${MAX_MODELS} · OpenRouter key set: ${apiKey ? "yes" : "NO — set OPENROUTER_API_KEY"}`,
      "",
      "Any model id available on OpenRouter works (https://openrouter.ai/models).",
    ].join("\n");
    return { content: [{ type: "text" as const, text }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-second-opinion running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
