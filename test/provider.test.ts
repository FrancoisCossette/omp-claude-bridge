import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createStreamClaudeAgentSdk } from "../provider.js";
import { SessionStore } from "../session-store.js";
import { ctx, resetStack } from "../query-state.js";
import type { McpResult } from "../extract-tool-results.js";
import type { BridgeRuntime, QueryFn } from "../runtime.js";

type Messages = Context["messages"];

const MODEL = {
  id: "claude-opus-4-7",
  name: "Claude Opus 4.7",
  api: "anthropic-messages",
  provider: "claude-bridge",
  reasoning: true,
  input: ["text"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} as unknown as Model<Api>;

const user = (text: string) =>
  ({ role: "user", content: text, timestamp: Date.now() }) as Messages[number];
const assistant = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  }) as Messages[number];
const toolResult = (toolCallId: string, text: string) =>
  ({
    role: "toolResult",
    toolCallId,
    content: text,
    timestamp: Date.now(),
  }) as unknown as Messages[number];

const makeContext = (messages: Messages): Context =>
  ({
    messages,
    systemPrompt: ["you are a test"],
    tools: [],
  }) as unknown as Context;

// SDK message builders.
const sysInit = (sessionId: string): SDKMessage =>
  ({ type: "system", subtype: "init", session_id: sessionId }) as unknown as SDKMessage;
const blockStartText = (index = 0): SDKMessage =>
  ({
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "text" } },
  }) as unknown as SDKMessage;
const textDelta = (text: string, index = 0): SDKMessage =>
  ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  }) as unknown as SDKMessage;
const blockStop = (index = 0): SDKMessage =>
  ({
    type: "stream_event",
    event: { type: "content_block_stop", index },
  }) as unknown as SDKMessage;
const textBlock = (text: string, index = 0): SDKMessage[] => [
  blockStartText(index),
  textDelta(text, index),
  blockStop(index),
];
const resultSuccess = (result: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    result,
    usage: { input_tokens: 10, output_tokens: 5 },
    num_turns: 1,
  }) as unknown as SDKMessage;

interface FakeQueryHandle {
  interruptCalls: number;
  closeCalls: number;
}

/** Scripted async-iterable Query. `gate`, when provided, blocks the stream after
 *  `pre` messages until resolved — used to hold a query "in flight". */
function makeFakeQuery(
  messages: SDKMessage[],
  handle: FakeQueryHandle,
  gate?: Promise<void>,
) {
  let interrupted = false;
  const gen = (async function* () {
    for (const m of messages) {
      if (interrupted) return;
      yield m;
    }
    if (gate) await gate;
  })();
  const q = gen as AsyncGenerator<SDKMessage> & {
    interrupt: () => Promise<void>;
    close: () => void;
    setPermissionMode?: () => Promise<void>;
  };
  q.interrupt = async () => {
    interrupted = true;
    handle.interruptCalls++;
  };
  q.close = () => {
    handle.closeCalls++;
  };
  return q;
}

function recordingQueryFn(
  scripts: SDKMessage[][],
  handles: FakeQueryHandle[],
  calls: Array<Parameters<QueryFn>[0]>,
  gate?: Promise<void>,
): QueryFn {
  let idx = 0;
  return ((args: Parameters<QueryFn>[0]) => {
    calls.push(args);
    const handle: FakeQueryHandle = { interruptCalls: 0, closeCalls: 0 };
    handles.push(handle);
    const script = scripts[idx] ?? [];
    // Only the first query is gated (held in flight); continuations run free.
    const g = idx === 0 ? gate : undefined;
    idx++;
    return makeFakeQuery(script, handle, g);
  }) as unknown as QueryFn;
}

async function collect(
  stream: AsyncIterable<{ type: string; [k: string]: unknown }>,
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of stream) events.push(e);
  return events;
}

let claudeDir: string;
let notifications: Array<{ message: string; level: string }>;
let runtime: BridgeRuntime;
let queryCalls: Array<Parameters<QueryFn>[0]>;
let handles: FakeQueryHandle[];
let prevConfigDir: string | undefined;

function makeRuntime(queryFn: QueryFn): BridgeRuntime {
  const sessions = new SessionStore((message, level) =>
    notifications.push({ message, level }),
  );
  return {
    providerSettings: {},
    longContextSettings: { plan: "pro", longContextExtraUsage: false },
    sessions,
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
    } as unknown as BridgeRuntime["ui"],
    askClaudeToolName: "AskClaude",
    cachedSystemPrompt: [],
    queryFn,
  };
}

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "cb-prov-"));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  notifications = [];
  queryCalls = [];
  handles = [];
  resetStack();
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  rmSync(claudeDir, { recursive: true, force: true });
  resetStack();
});

describe("fresh query", () => {
  test("streams text and finalizes with a done event", async () => {
    const queryFn = recordingQueryFn(
      [[sysInit("sess-aaaa1111"), ...textBlock("hello world"), resultSuccess("hello world")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    const stream = createStreamClaudeAgentSdk(runtime)(
      MODEL,
      makeContext([user("hi")]),
    );

    const events = await collect(stream);

    expect(queryCalls).toHaveLength(1);
    expect(events[0].type).toBe("start");
    expect(events.at(-1)!.type).toBe("done");
    expect(events.at(-1)!.reason).toBe("stop");
    // Delegated event-mapping detail lives in stream-processing tests; here we
    // only assert the streamed text surfaced somewhere in the sequence.
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toContain("hello world");
  });

  test("passes the resolved cli model id to the SDK", async () => {
    const queryFn = recordingQueryFn(
      [[sysInit("sess-bbbb2222"), resultSuccess("ok")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    await collect(
      createStreamClaudeAgentSdk(runtime)(MODEL, makeContext([user("hi")])),
    );

    expect(queryCalls[0].options?.extraArgs?.model).toBe("claude-opus-4-7");
  });

  test("forwards configured Claude Code settings to the SDK", async () => {
    const queryFn = recordingQueryFn(
      [[sysInit("sess-bbbb3333"), resultSuccess("ok")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    runtime.providerSettings = {
      settings: { claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"] },
    };
    await collect(
      createStreamClaudeAgentSdk(runtime)(MODEL, makeContext([user("hi")])),
    );

    expect(queryCalls[0].options?.settings).toEqual({
      claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"],
    });
  });

  test("passes no settings when none are configured", async () => {
    const queryFn = recordingQueryFn(
      [[sysInit("sess-bbbb4444"), resultSuccess("ok")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    await collect(
      createStreamClaudeAgentSdk(runtime)(MODEL, makeContext([user("hi")])),
    );

    expect(queryCalls[0].options?.settings).toBeUndefined();
  });

  test("commits the captured session id after a successful query", async () => {
    const queryFn = recordingQueryFn(
      [[sysInit("sess-cccc3333"), resultSuccess("done")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    await collect(
      createStreamClaudeAgentSdk(runtime)(MODEL, makeContext([user("hi")])),
    );

    expect(runtime.sessions.current?.sessionId).toBe("sess-cccc3333");
  });

  test("closes the SDK query and clears the active context when done", async () => {
    const queryFn = recordingQueryFn(
      [[sysInit("sess-dddd4444"), resultSuccess("done")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    await collect(
      createStreamClaudeAgentSdk(runtime)(MODEL, makeContext([user("hi")])),
    );

    expect(handles[0].closeCalls).toBeGreaterThan(0);
    expect(ctx().activeQuery).toBeNull();
  });
});

describe("tool-result delivery", () => {
  test("routes a matching tool result to a waiting handler and defers no query", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const queryFn = recordingQueryFn(
      [[sysInit("sess-eeee5555")]],
      handles,
      queryCalls,
      gate,
    );
    runtime = makeRuntime(queryFn);
    const stream = createStreamClaudeAgentSdk(runtime);

    // Start a query that stays in flight (gated), then register a waiting handler
    // as the MCP server would when Claude invokes a custom tool.
    stream(MODEL, makeContext([user("do a thing")]));
    await Promise.resolve();
    const queryCtx = ctx();
    let delivered: McpResult | undefined;
    queryCtx.pendingToolCalls.set("tc-1", {
      toolName: "mcp__custom-tools__read",
      resolve: (r) => {
        delivered = r;
      },
    });
    queryCtx.latestCursor = 1;

    // A second stream call carrying the tool result must route to the handler,
    // not spawn a new query.
    const callsBefore = queryCalls.length;
    const followUp = stream(
      MODEL,
      makeContext([
        user("do a thing"),
        assistant("calling read"),
        toolResult("tc-1", "file contents"),
      ]),
    );

    expect(queryCalls.length).toBe(callsBefore);
    expect(delivered).toBeDefined();
    const block = delivered?.content[0];
    expect(block?.type === "text" ? block.text : undefined).toBe("file contents");
    expect(queryCtx.pendingToolCalls.has("tc-1")).toBe(false);

    // The tool-result call claims the shared stream, so the *follow-up* stream is
    // the one finalized once the gated query completes.
    releaseGate();
    await collect(followUp);
  });
});

describe("abort", () => {
  test("interrupts the query, rotates the session, and emits an error event", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const controller = new AbortController();
    const queryFn = recordingQueryFn(
      [[sysInit("sess-ffff6666"), textDelta("partial")]],
      handles,
      queryCalls,
      gate,
    );
    runtime = makeRuntime(queryFn);
    runtime.sessions.commit("sess-ffff6666", 0, claudeDir);

    const options = { signal: controller.signal } as unknown as SimpleStreamOptions;
    const stream = createStreamClaudeAgentSdk(runtime)(
      MODEL,
      makeContext([user("long task")]),
      options,
    );

    await Promise.resolve();
    controller.abort();
    releaseGate();

    const events = await collect(stream);

    expect(handles[0].interruptCalls).toBeGreaterThan(0);
    expect(events.at(-1)!.type).toBe("error");
    expect(events.at(-1)!.reason).toBe("aborted");
    expect(runtime.sessions.current?.needsRebuild).toBe(true);
    expect(runtime.sessions.current?.forceRotate).toBe(true);
    expect(ctx().activeQuery).toBeNull();
  });
});

describe("deferred user-message replay", () => {
  test("replays a user message steered in during tool-wait as a continuation query", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const queryFn = recordingQueryFn(
      [
        [sysInit("sess-7777aaaa")], // gated first query
        [textDelta("continued"), resultSuccess("continued")], // continuation
      ],
      handles,
      queryCalls,
      gate,
    );
    runtime = makeRuntime(queryFn);
    const stream = createStreamClaudeAgentSdk(runtime);

    stream(MODEL, makeContext([user("start")]));
    await Promise.resolve();
    const queryCtx = ctx();
    // Simulate a waiting handler + its result arriving with a steered user message.
    queryCtx.pendingToolCalls.set("tc-9", {
      toolName: "mcp__custom-tools__read",
      resolve: () => {},
    });
    queryCtx.latestCursor = 1;
    const followUp = stream(
      MODEL,
      makeContext([
        user("start"),
        assistant("calling read"),
        toolResult("tc-9", "result"),
        user("also do this next"),
      ]),
    );

    expect(queryCtx.deferredUserMessages).toContain("also do this next");

    releaseGate();
    await collect(followUp);

    // The deferred message drove a continuation query with resume set.
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);
    expect(queryCalls[1].options?.resume).toBe("sess-7777aaaa");
    expect(queryCalls[1].prompt).toBe("also do this next");
  });
});

describe("OMP session id: /clear and side-channel calls", () => {
  const opts = (sessionId: string) =>
    ({ sessionId }) as unknown as SimpleStreamOptions;

  test("/clear (new OMP session id) starts a new Claude session instead of keeping the old one", async () => {
    const queryFn = recordingQueryFn(
      [[sysInit("sess-after-clear"), resultSuccess("ok")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    runtime.sessions.commit("sess-before-clear", 22, claudeDir, "omp-1");

    await collect(
      createStreamClaudeAgentSdk(runtime)(
        MODEL,
        makeContext([user("after clear")]),
        opts("omp-2"),
      ),
    );

    expect(queryCalls[0].options?.resume).toBeUndefined();
    expect(runtime.sessions.current?.sessionId).toBe("sess-after-clear");
    expect(runtime.sessions.current?.ompSessionId).toBe("omp-2");
  });

  test("tool results of a throwaway query do not move the shared cursor", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const queryFn = recordingQueryFn(
      [[sysInit("sess-throwaway")]],
      handles,
      queryCalls,
      gate,
    );
    runtime = makeRuntime(queryFn);
    runtime.sessions.commit("sess-shared", 22, claudeDir, "omp-1");
    const stream = createStreamClaudeAgentSdk(runtime);

    // Shorter context, same OMP session: throwaway query, shared session kept.
    stream(MODEL, makeContext([user("short")]), opts("omp-1"));
    await Promise.resolve();
    const queryCtx = ctx();
    queryCtx.pendingToolCalls.set("tc-1", {
      toolName: "mcp__custom-tools__read",
      resolve: () => {},
    });
    const followUp = stream(
      MODEL,
      makeContext([
        user("short"),
        assistant("calling read"),
        toolResult("tc-1", "file contents"),
      ]),
      opts("omp-1"),
    );

    expect(runtime.sessions.current?.sessionId).toBe("sess-shared");
    expect(runtime.sessions.current?.cursor).toBe(22);

    releaseGate();
    await collect(followUp);
    expect(runtime.sessions.current?.sessionId).toBe("sess-shared");
    expect(runtime.sessions.current?.cursor).toBe(22);
  });

  test("a side-channel call runs on its own session and leaves the shared one alone", async () => {
    const queryFn = recordingQueryFn(
      [[sysInit("sess-side"), resultSuccess("a title")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    runtime.sessions.commit("sess-main", 2, claudeDir, "omp-1");

    await collect(
      createStreamClaudeAgentSdk(runtime)(
        MODEL,
        makeContext([user("hello"), assistant("hi"), user("<title-request>")]),
        opts("omp-1:side:abc123"),
      ),
    );

    const resume = queryCalls[0].options?.resume;
    expect(resume).toBeDefined();
    expect(resume).not.toBe("sess-main");
    expect(runtime.sessions.current?.sessionId).toBe("sess-main");
    expect(runtime.sessions.current?.cursor).toBe(2);
    expect(runtime.sessions.current?.ompSessionId).toBe("omp-1");
  });
});

describe("after omp compacted the history", () => {
  const opts = (sessionId: string) =>
    ({ sessionId }) as unknown as SimpleStreamOptions;
  const summary = (text: string, historyRewriteAt: number) =>
    ({
      role: "user",
      content: [{ type: "text", text: `<summary>\n${text}\n</summary>` }],
      attribution: "agent",
      historyRewriteAt,
      timestamp: historyRewriteAt,
    }) as unknown as Messages[number];

  test("the next prompt resumes a session rebuilt from the summary, not a blank one", async () => {
    // Seen on 2026-11-07: a run compacted mid-way ended with the cursor of
    // ~640 messages; the next prompt (summary + 1 message) started blank.
    const queryFn = recordingQueryFn(
      [[sysInit("sess-rebuilt"), resultSuccess("HERON")]],
      handles,
      queryCalls,
    );
    runtime = makeRuntime(queryFn);
    runtime.sessions.commit("sess-main", 640, claudeDir, "omp-1");

    await collect(
      createStreamClaudeAgentSdk(runtime)(
        MODEL,
        makeContext([
          summary("the code word is HERON", 1000),
          user("what is the code word?"),
        ]),
        opts("omp-1"),
      ),
    );

    const resume = queryCalls[0].options?.resume;
    expect(resume).toBeDefined();
    expect(resume).not.toBe("sess-main");
    expect(runtime.sessions.current?.sessionId).toBe("sess-rebuilt");
    expect(runtime.sessions.current?.rewriteAt).toBe(1000);
    expect(runtime.sessions.current?.cursor).toBe(2);
  });

  test("a query left open elsewhere does not keep the next prompt blank", async () => {
    // Seen in the real test of 2026-11-08: a subagent's query stayed open, so
    // the main prompt after the compaction was handled as reentrant.
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const queryFn = recordingQueryFn(
      [[sysInit("sess-open")], [sysInit("sess-rebuilt"), resultSuccess("HERON")]],
      handles,
      queryCalls,
      gate,
    );
    runtime = makeRuntime(queryFn);
    runtime.sessions.commit("sess-main", 640, claudeDir, "omp-1");
    const stream = createStreamClaudeAgentSdk(runtime);

    const open = stream(MODEL, makeContext([user("elsewhere")]), opts("omp-1"));
    await Promise.resolve();
    expect(ctx().activeQuery).not.toBeNull();

    const next = stream(
      MODEL,
      makeContext([
        summary("the code word is HERON", 1000),
        user("what is the code word?"),
      ]),
      opts("omp-1"),
    );
    await collect(next);

    const resume = queryCalls[1].options?.resume;
    expect(resume).toBeDefined();
    expect(resume).not.toBe("sess-main");

    releaseGate();
    await collect(open);
  });
});
