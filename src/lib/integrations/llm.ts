// Phase 7H — LLM provider adapters for AI commentary.
//
// CRITICAL safety constraints:
//   - Drafts are stored as PENDING and require human approval.
//   - The provider is invoked only with already-aggregated tenant data —
//     never with raw PII like SIN or banking PANs (those are redacted upstream).
//   - The default adapter is the mockLLMAdapter for dev / tests, so the
//     workflow can be exercised without a paid account.

import { getActiveIntegration, readConfig, readSecrets } from "./config";

export interface LLMProvider {
  name: string;
  generate(args: { model?: string; system?: string; prompt: string; temperature?: number }): Promise<{
    text: string; model: string; promptTokens?: number; completionTokens?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Mock — deterministic, audit-safe; always available for dev + tests.
// ---------------------------------------------------------------------------
export const mockLLMProvider: LLMProvider = {
  name: "mock",
  async generate({ prompt, system, model }) {
    const head = system ? `[SYSTEM] ${system}\n\n` : "";
    const body = `Generated commentary (mock provider).\n\nContext summary:\n${prompt.slice(0, 800)}\n\nKey observations:\n- This is a placeholder. Replace with a real provider before publishing.\n- The variance pattern in the supplied data warrants management review.\n- No accounting recommendations should be acted on without human approval.`;
    return { text: head + body, model: model ?? "mock-1", promptTokens: prompt.length, completionTokens: body.length };
  },
};

// ---------------------------------------------------------------------------
// Anthropic (Claude) — dynamic import.
// ---------------------------------------------------------------------------
export async function anthropicProvider(args: { apiKey: string; defaultModel: string }): Promise<LLMProvider> {
  const { optionalImport } = await import("./optional-import");
  const mod = await optionalImport("@anthropic-ai/sdk");
  if (!mod) {
    return { name: "anthropic-missing", async generate() { throw new Error("@anthropic-ai/sdk not installed"); } };
  }
  const Anthropic = mod.default ?? mod.Anthropic;
  const client = new Anthropic({ apiKey: args.apiKey }) as { messages: { create: (args: { model: string; max_tokens: number; system?: string; messages: Array<{ role: string; content: string }> }) => Promise<{ content: Array<{ text: string }>; model: string; usage?: { input_tokens?: number; output_tokens?: number } }> } };
  return {
    name: "anthropic",
    async generate({ prompt, system, model, temperature }) {
      void temperature;
      const result = await client.messages.create({
        model: model ?? args.defaultModel,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: prompt }],
      });
      const text = result.content.map((c) => c.text).join("\n");
      return {
        text, model: result.model,
        promptTokens: result.usage?.input_tokens, completionTokens: result.usage?.output_tokens,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI — dynamic import.
// ---------------------------------------------------------------------------
export async function openaiProvider(args: { apiKey: string; defaultModel: string }): Promise<LLMProvider> {
  const { optionalImport } = await import("./optional-import");
  const mod = await optionalImport("openai");
  if (!mod) {
    return { name: "openai-missing", async generate() { throw new Error("openai not installed"); } };
  }
  const OpenAI = mod.default ?? mod.OpenAI;
  const client = new OpenAI({ apiKey: args.apiKey }) as { chat: { completions: { create: (args: { model: string; messages: Array<{ role: "system" | "user"; content: string }> }) => Promise<{ choices: Array<{ message: { content: string | null } }>; model: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> } } };
  return {
    name: "openai",
    async generate({ prompt, system, model }) {
      const messages: Array<{ role: "system" | "user"; content: string }> = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      const result = await client.chat.completions.create({ model: model ?? args.defaultModel, messages });
      const text = result.choices[0]?.message?.content ?? "";
      return {
        text, model: result.model,
        promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
export async function selectLLMProvider(clubId: string): Promise<LLMProvider> {
  const setting = await getActiveIntegration(clubId, "LLM");
  if (!setting) return mockLLMProvider;
  const config = readConfig<{ model?: string }>(setting);
  const secrets = readSecrets<{ apiKey?: string }>(setting);
  if (setting.provider === "anthropic") {
    if (!secrets.apiKey) return mockLLMProvider;
    return anthropicProvider({ apiKey: secrets.apiKey, defaultModel: config.model ?? "claude-sonnet-4-6" });
  }
  if (setting.provider === "openai") {
    if (!secrets.apiKey) return mockLLMProvider;
    return openaiProvider({ apiKey: secrets.apiKey, defaultModel: config.model ?? "gpt-4o-mini" });
  }
  return mockLLMProvider;
}
