import { describe, expect, test } from "bun:test";
import {
  MODELS,
  applyLongContext,
  claudeCodeModelId,
  resolveClaudeCodeRuntimeModel,
  resolveModel,
} from "../models.js";

const PRO = { plan: "pro" as const, longContextExtraUsage: false };
const MAX = { plan: "max" as const, longContextExtraUsage: false };
const PRO_EXTRA = { plan: "pro" as const, longContextExtraUsage: true };

describe("resolveModel", () => {
  test("matches exact ids", () => {
    expect(resolveModel(MODELS, "claude-haiku-4-5")?.id).toBe("claude-haiku-4-5");
  });

  test("partial match returns the first model in display order", () => {
    expect(resolveModel(MODELS, "fable")?.id).toBe("claude-fable-5-1");
    expect(resolveModel(MODELS, "opus")?.id).toBe("claude-opus-5");
    expect(resolveModel(MODELS, "sonnet")?.id).toBe("claude-sonnet-5");
  });

  test("is case-insensitive and returns undefined on miss", () => {
    expect(resolveModel(MODELS, "HAIKU")?.id).toBe("claude-haiku-4-5");
    expect(resolveModel(MODELS, "gpt-4")).toBeUndefined();
  });
});

// Pins the *measured* SDK behavior table — intentionally not derived from the
// catalog's advertised contextWindow (see models.ts).
describe("resolveClaudeCodeRuntimeModel", () => {
  test("fable-5-1 and fable-5 serve 1M with the [1m] suffix", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-fable-5-1", PRO)).toEqual({
      cliModelId: "claude-fable-5-1[1m]",
      contextWindow: 1_000_000,
    });
    expect(resolveClaudeCodeRuntimeModel("claude-fable-5", PRO)).toEqual({
      cliModelId: "claude-fable-5[1m]",
      contextWindow: 1_000_000,
    });
  });

  test("bare opus-4-7 serves 1M; opus-5 and opus-4-8 need the [1m] suffix", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-opus-5", PRO)).toEqual({
      cliModelId: "claude-opus-5[1m]",
      contextWindow: 1_000_000,
    });
    expect(resolveClaudeCodeRuntimeModel("claude-opus-4-7", PRO)).toEqual({
      cliModelId: "claude-opus-4-7",
      contextWindow: 1_000_000,
    });
    expect(resolveClaudeCodeRuntimeModel("claude-opus-4-8", PRO)).toEqual({
      cliModelId: "claude-opus-4-8[1m]",
      contextWindow: 1_000_000,
    });
  });

  test("opus-4-6 1M is gated by plan or extra usage", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO)).toEqual({
      cliModelId: "claude-opus-4-6",
      contextWindow: 200_000,
    });
    expect(resolveClaudeCodeRuntimeModel("claude-opus-4-6", MAX).cliModelId).toBe(
      "claude-opus-4-6[1m]",
    );
    expect(
      resolveClaudeCodeRuntimeModel("claude-opus-4-6", PRO_EXTRA).cliModelId,
    ).toBe("claude-opus-4-6[1m]");
  });

  test("sonnet-4-6 1M is gated by extra usage only", () => {
    expect(
      resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", MAX).contextWindow,
    ).toBe(200_000);
    expect(
      resolveClaudeCodeRuntimeModel("claude-sonnet-4-6", PRO_EXTRA).cliModelId,
    ).toBe("claude-sonnet-4-6[1m]");
  });

  test("haiku stays at 200K; unknown models default to 200K passthrough", () => {
    expect(resolveClaudeCodeRuntimeModel("claude-haiku-4-5", MAX)).toEqual({
      cliModelId: "claude-haiku-4-5",
      contextWindow: 200_000,
    });
    expect(resolveClaudeCodeRuntimeModel("mystery-model", PRO)).toEqual({
      cliModelId: "mystery-model",
      contextWindow: 200_000,
    });
  });
});

describe("claudeCodeModelId", () => {
  test("returns the CLI model id for the settings", () => {
    expect(claudeCodeModelId({ id: "claude-sonnet-5" }, PRO)).toBe(
      "claude-sonnet-5[1m]",
    );
    expect(claudeCodeModelId({ id: "claude-opus-4-6" }, PRO)).toBe(
      "claude-opus-4-6",
    );
  });
});

describe("applyLongContext", () => {
  test("registered contextWindow matches the served window and 1M names are suffixed", () => {
    const models = applyLongContext(MODELS, PRO);
    const opus46 = models.find((m) => m.id === "claude-opus-4-6")!;
    expect(opus46.contextWindow).toBe(200_000);
    expect(opus46.name).toBe("Claude Opus 4.6");

    const sonnet5 = models.find((m) => m.id === "claude-sonnet-5")!;
    expect(sonnet5.contextWindow).toBe(1_000_000);
    expect(sonnet5.name).toMatch(/1M$/);
  });

  test("returns the same object when nothing changes", () => {
    const haiku = MODELS.find((m) => m.id === "claude-haiku-4-5")!;
    const mapped = applyLongContext(MODELS, PRO).find(
      (m) => m.id === "claude-haiku-4-5",
    )!;
    expect(mapped).toBe(haiku);
  });

  test("does not double-suffix 1M names", () => {
    const once = applyLongContext(MODELS, PRO);
    const twice = applyLongContext(once, PRO);
    const sonnet5 = twice.find((m) => m.id === "claude-sonnet-5")!;
    expect(sonnet5.name.match(/1M/g)).toHaveLength(1);
  });
});
