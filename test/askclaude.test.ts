import { beforeEach, describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ASKCLAUDE_ALWAYS_BLOCKED,
  MODE_DISALLOWED_TOOLS,
  errorMessage,
  promptAndWait,
} from "../askclaude.js";
import { SessionRegistry } from "../session-store.js";
import type { ToolCallState } from "../askclaude-ui.js";
import type { BridgeRuntime, QueryFn } from "../runtime.js";

const resultSuccess = (result: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    result,
    usage: { input_tokens: 3, output_tokens: 2 },
    num_turns: 1,
  }) as unknown as SDKMessage;

const resultError = (): SDKMessage =>
  ({
    type: "result",
    subtype: "error_max_turns",
    num_turns: 5,
  }) as unknown as SDKMessage;

function fakeQuery(messages: SDKMessage[] | (() => AsyncGenerator<SDKMessage>)) {
  const gen =
    typeof messages === "function"
      ? messages()
      : (async function* () {
          for (const m of messages) yield m;
        })();
  const q = gen as AsyncGenerator<SDKMessage> & {
    interrupt: () => Promise<void>;
    close: () => void;
  };
  q.interrupt = async () => {};
  q.close = () => {};
  return q;
}

let queryCalls: Array<Parameters<QueryFn>[0]>;
let runtime: BridgeRuntime;

function makeRuntime(
  messages: SDKMessage[] | (() => AsyncGenerator<SDKMessage>),
): BridgeRuntime {
  const queryFn = ((args: Parameters<QueryFn>[0]) => {
    queryCalls.push(args);
    return fakeQuery(messages);
  }) as unknown as QueryFn;
  return {
    providerSettings: {},
    longContextSettings: { plan: "pro", longContextExtraUsage: false },
    sessions: new SessionRegistry(() => {}),
    activeQueryContexts: new Set(),
    ui: null,
    askClaudeToolName: "AskClaude",
    cachedSystemPrompt: [],
    queryFn,
  };
}

const noToolCalls = () => new Map<string, ToolCallState>();

beforeEach(() => {
  queryCalls = [];
});

describe("promptAndWait mode gating", () => {
  test("full mode blocks only the always-blocked interactive tools", async () => {
    runtime = makeRuntime([resultSuccess("ok")]);
    await promptAndWait(runtime, "hi", "full", noToolCalls());
    expect(queryCalls[0].options?.disallowedTools).toEqual(
      MODE_DISALLOWED_TOOLS.full,
    );
    for (const t of ASKCLAUDE_ALWAYS_BLOCKED) {
      expect(queryCalls[0].options?.disallowedTools).toContain(t);
    }
  });

  test("read mode additionally blocks write/bash tools", async () => {
    runtime = makeRuntime([resultSuccess("ok")]);
    await promptAndWait(runtime, "hi", "read", noToolCalls());
    const blocked = queryCalls[0].options?.disallowedTools ?? [];
    expect(blocked).toEqual(MODE_DISALLOWED_TOOLS.read);
    expect(blocked).toContain("Write");
    expect(blocked).toContain("Bash");
    expect(blocked).not.toContain("Read");
  });

  test("none mode also blocks read/explore tools", async () => {
    runtime = makeRuntime([resultSuccess("ok")]);
    await promptAndWait(runtime, "hi", "none", noToolCalls());
    const blocked = queryCalls[0].options?.disallowedTools ?? [];
    expect(blocked).toEqual(MODE_DISALLOWED_TOOLS.none);
    expect(blocked).toContain("Read");
    expect(blocked).toContain("Grep");
    expect(blocked).toContain("WebSearch");
  });

  test("every mode includes the always-blocked set", () => {
    for (const mode of ["full", "read", "none"] as const) {
      for (const t of ASKCLAUDE_ALWAYS_BLOCKED) {
        expect(MODE_DISALLOWED_TOOLS[mode]).toContain(t);
      }
    }
  });
});

describe("promptAndWait result handling", () => {
  test("returns the SDK result text on success", async () => {
    runtime = makeRuntime([resultSuccess("the answer")]);
    const { responseText, stopReason } = await promptAndWait(
      runtime,
      "q",
      "read",
      noToolCalls(),
    );
    expect(responseText).toBe("the answer");
    expect(stopReason).toBe("stop");
  });

  test("does not hang on a non-success result subtype", async () => {
    runtime = makeRuntime([resultError()]);
    const { stopReason } = await promptAndWait(
      runtime,
      "q",
      "read",
      noToolCalls(),
    );
    // Current behavior: an error subtype still terminates (no hang). Pinning this
    // so a future change to surface the error explicitly is a deliberate edit.
    expect(stopReason).toBe("stop");
  });
});

describe("promptAndWait error surfaces", () => {
  test("rejects (does not hang) when the SDK stream throws", async () => {
    runtime = makeRuntime(async function* () {
      throw new Error("SDK subprocess died");
      // eslint-disable-next-line no-unreachable
      yield resultSuccess("never");
    });
    await expect(
      promptAndWait(runtime, "q", "read", noToolCalls()),
    ).rejects.toThrow("SDK subprocess died");
  });

  test("aborts immediately when the signal is already aborted", async () => {
    runtime = makeRuntime([resultSuccess("unused")]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      promptAndWait(runtime, "q", "read", noToolCalls(), controller.signal),
    ).rejects.toThrow("Aborted");
  });
});

describe("errorMessage", () => {
  test("unwraps Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  test("reads message/error fields off plain objects", () => {
    expect(errorMessage({ message: "m" })).toBe("m");
    expect(errorMessage({ error: "e" })).toBe("e");
  });
  test("falls back to String for primitives", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});
