// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Ported from pi-claude-bridge; model metadata sourced from oh-my-pi catalog (models.json anthropic entries).

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const MODEL_IDS_IN_ORDER = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

// Workaround for missing thinkingLevelMap in pi-ai.
// Sonnet 5 and Sonnet 4.6 have no map, so getSupportedThinkingLevels hides
// xhigh (it's opt-in). Both models' top effort tier is "max" with no real
// xhigh, so xhigh→max matches opus-4-6.
export const DEFAULT_THINKING_LEVEL_MAPS: Record<string, Record<string, string>> = {
  "claude-sonnet-5": { xhigh: "max" },
  "claude-sonnet-4-6": { xhigh: "max" },
};

// Raw catalog data keyed by model id. Must precede MODELS — referenced during its construction.
const MODEL_DEFS: Record<string, {
  id: string;
  name: string;
  reasoning: boolean;
  thinking?: { mode: string; efforts: string[]; supportsDisplay?: boolean };
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}> = {
  "claude-fable-5-1": {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "claude-fable-5": {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "claude-opus-5": {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "claude-opus-4-7": {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "max"] },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"], supportsDisplay: true },
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high"] },
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: true,
    thinking: { mode: "budget", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
    input: ["text", "image"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
};

// Hardcoded model definitions sourced from oh-my-pi/packages/catalog/src/models.json
// (anthropic provider entries) at port time. Zero catalog import dependency.
export const MODELS: ProviderModelConfig[] = MODEL_IDS_IN_ORDER.map((id) => {
  const entry = MODEL_DEFS[id];
  if (!entry) return null!;
  const result = {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: entry.input,
    cost: entry.cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  } satisfies ProviderModelConfig;
  if (DEFAULT_THINKING_LEVEL_MAPS[id]) {
    (result as Record<string, unknown>).thinkingLevelMap = DEFAULT_THINKING_LEVEL_MAPS[id];
  }
  return result;
}).filter((m): m is NonNullable<typeof m> => m != null);


export type LongContextSettings = {
  plan: "pro" | "max";
  longContextExtraUsage: boolean;
};

export type ClaudeCodeRuntimeModel = {
  cliModelId: string;
  contextWindow: number;
};

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// Measured Claude Agent SDK subscription/OAuth behavior. Do not infer this from
// pi-ai's advertised contextWindow: bare Opus 4.7 serves 1M, bare Opus 4.8 does
// not, and [1m] entitlement differs by model.
export function resolveClaudeCodeRuntimeModel(
  modelId: string,
  settings: LongContextSettings,
): ClaudeCodeRuntimeModel {
  switch (modelId) {
    case "claude-opus-5":
      return { cliModelId: "claude-opus-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-8":
      return { cliModelId: "claude-opus-4-8[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-7":
      return { cliModelId: "claude-opus-4-7", contextWindow: ONE_M_CONTEXT };
    case "claude-opus-4-6": {
      const useOneM = settings.plan === "max" || settings.longContextExtraUsage;
      return {
        cliModelId: useOneM ? "claude-opus-4-6[1m]" : "claude-opus-4-6",
        contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
      };
    }
    case "claude-fable-5-1":
      return { cliModelId: "claude-fable-5-1[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-fable-5":
      return { cliModelId: "claude-fable-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-sonnet-5":
      return { cliModelId: "claude-sonnet-5[1m]", contextWindow: ONE_M_CONTEXT };
    case "claude-sonnet-4-6":
      return {
        cliModelId: settings.longContextExtraUsage
          ? "claude-sonnet-4-6[1m]"
          : "claude-sonnet-4-6",
        contextWindow: settings.longContextExtraUsage
          ? ONE_M_CONTEXT
          : TWO_HUNDRED_K_CONTEXT,
      };
    case "claude-haiku-4-5":
      return { cliModelId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K_CONTEXT };
    default:
      console.error(
        `claude-bridge: encountered model ${modelId} with no known context size, defaulting to 200K`,
      );
      return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
  }
}

export function claudeCodeModelId(
  model: { id: string },
  settings: LongContextSettings,
): string {
  return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(
  models: T[],
  input: string,
): T | undefined {
  const lower = input.toLowerCase();
  return models.find((m) => m.id === lower || m.id.includes(lower));
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport. The runtime policy is based
// on measured SDK behavior.
export function applyLongContext<
  T extends { id: string; name: string; contextWindow?: number | null },
>(models: T[], settings: LongContextSettings): T[] {
  return models.map((m) => {
    const { contextWindow } = resolveClaudeCodeRuntimeModel(m.id, settings);
    const name =
      contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name)
        ? `${m.name} 1M`
        : m.name;
    return contextWindow === m.contextWindow && name === m.name
      ? m
      : { ...m, contextWindow, name };
  });
}
