#!/usr/bin/env node
/**
 * mcp-second-opinion — an MCP server that asks a panel of LLMs (via OpenRouter)
 * the same question in parallel and returns every answer side by side, with an
 * optional synthesis that surfaces where the models disagree.
 *
 * Config (environment):
 *   OPENROUTER_API_KEY        required — your OpenRouter key (BYOK)
 *   SECOND_OPINION_MODELS     optional — comma-separated default panel
 *   SECOND_OPINION_SYNTH      optional — model used for synthesis
 *   SECOND_OPINION_TIMEOUT_MS optional — per-model timeout (default 60000)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askPanel, synthesize, formatResult } from "./panel.js";

const DEFAULT_MODELS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.5-flash-lite",
];
const DEFAULT_SYNTH = "openai/gpt-4o-mini";

function parseModels(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_MODELS;
  const list = raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_MODELS;
}

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const defaultPanel = parseModels(process.env.SECOND_OPINION_MODELS);
const synthModel = process.env.SECOND_OPINION_SYNTH?.trim() || DEFAULT_SYNTH;
const timeoutMs = Number(process.env.SECOND_OPINION_TIMEOUT_MS) || 60_000;

const server = new McpServer({
  name: "mcp-second-opinion",
  version: "0.1.0",
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
      prompt: z.string().min(1).describe("The question to put to the panel."),
      models: z
        .array(z.string())
        .optional()
        .describe(
          "OpenRouter model ids to query (e.g. 'openai/gpt-4o-mini'). Omit to use the configured default panel.",
        ),
      synthesize: z
        .boolean()
        .optional()
        .describe(
          "If true, a synthesizer model compares the answers and reports where they agree and disagree.",
        ),
      system: z
        .string()
        .optional()
        .describe("Optional system prompt sent to every model in the panel."),
    },
  },
  async (args) => {
    if (!apiKey) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "OPENROUTER_API_KEY is not set. Add it to the server's environment (get a key at https://openrouter.ai/keys).",
          },
        ],
      };
    }

    const models = args.models && args.models.length > 0 ? args.models : defaultPanel;

    const answers = await askPanel({
      apiKey,
      prompt: args.prompt,
      models,
      system: args.system,
      timeoutMs,
    });

    let synthesis: string | undefined;
    if (args.synthesize && answers.some((a) => a.ok)) {
      try {
        synthesis = await synthesize({
          apiKey,
          prompt: args.prompt,
          answers,
          model: synthModel,
          timeoutMs,
        });
      } catch (err) {
        synthesis = `_(synthesis failed: ${err instanceof Error ? err.message : String(err)})_`;
      }
    }

    return {
      content: [{ type: "text" as const, text: formatResult(args.prompt, answers, synthesis) }],
    };
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
      `Per-model timeout: ${timeoutMs}ms`,
      `OpenRouter key set: ${apiKey ? "yes" : "NO — set OPENROUTER_API_KEY"}`,
      "",
      "Any model id available on OpenRouter works (https://openrouter.ai/models).",
    ].join("\n");
    return { content: [{ type: "text" as const, text }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (stdout is the JSON-RPC channel and must stay clean).
  console.error("mcp-second-opinion running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
