// The claude-bridge provider: streams a pi context through the Claude Agent
// SDK. Ported from pi-claude-bridge verbatim, parameterized by BridgeRuntime.

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import {
  query,
  type EffortLevel,
  type Query,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { deleteSession } from "cc-session-io";
import { debug, diagDump, makeCliDebugOptions } from "./debug.js";
import { claudeCodeModelId } from "./models.js";
import {
  extractAllToolResults as _extractAllToolResults,
  type McpResult,
} from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import {
  buildMcpServers,
  contextForToolResults,
  resolveMcpTools,
} from "./mcp-bridge.js";
import {
  buildSystemPromptAppend,
  extractUserPrompt,
  extractUserPromptBlocks,
  wrapPromptStream,
} from "./prompt.js";
import {
  claimCurrentPiStream,
  consumeQuery,
  finalizeCurrentStream,
  markStreamComplete,
} from "./stream-processing.js";
import { REASONING_TO_EFFORT } from "./tool-mapping.js";
import type { BridgeRuntime } from "./runtime.js";

// Compat: use factory if available, else fall back to constructor
const _piAi = piAi as Record<string, unknown> & typeof piAi;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
  typeof _piAi.createAssistantMessageEventStream === "function"
    ? (_piAi.createAssistantMessageEventStream as () => AssistantMessageEventStream)
    : () =>
        new (_piAi.AssistantMessageEventStream as new () => AssistantMessageEventStream)();

export type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function createStreamClaudeAgentSdk(
  runtime: BridgeRuntime,
): StreamSimpleFn {
  const activeQueryContexts = new Set<QueryContext>();

  function extractAllToolResults(context: Context): McpResult[] {
    const { results, stopIdx } = _extractAllToolResults(
      context.messages as unknown as Array<{
        role: string;
        [key: string]: unknown;
      }>,
    );
    debug(
      `extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`,
    );
    debug(
      `extractAllToolResults: all msg roles:`,
      context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
    );
    for (let r = 0; r < results.length; r++) {
      debug(
        `extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`,
        JSON.stringify(results[r].content).slice(0, 150),
      );
    }
    return results;
  }

  return function streamClaudeAgentSdk(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = newAssistantMessageEventStream();
    const sessions = runtime.sessions;

    // pi-ai's published Message role union omits "developer", which oh-my-pi's
    // runtime does send; role is a plain string at runtime regardless.
    const lastMsgRole = context.messages[context.messages.length - 1]?.role as
      | string
      | undefined;
    debug(
      `provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`,
    );

    const activeQuery = ctx().activeQuery !== null;
    const allResults =
      activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
    const resultCtx =
      allResults.length > 0
        ? contextForToolResults(allResults, activeQueryContexts)
        : undefined;
    const isReentrantUserQuery =
      activeQuery &&
      (lastMsgRole === "user" || lastMsgRole === "developer") &&
      allResults.length === 0;
    if (isReentrantUserQuery) {
      debug(
        `provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`,
      );
    }

    // --- Tool result delivery ---
    if (resultCtx) {
      claimCurrentPiStream(stream, "tool-result", resultCtx);
      resultCtx.resetTurnState(model);
      debug(
        `provider: tool results, ${allResults.length} results, ${resultCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`,
      );
      for (const result of allResults) {
        const id = result.toolCallId;
        if (id && resultCtx.pendingToolCalls.has(id)) {
          const pending = resultCtx.pendingToolCalls.get(id)!;
          resultCtx.pendingToolCalls.delete(id);
          debug(
            `provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`,
            JSON.stringify(result.content).slice(0, 200),
          );
          pending.resolve(result);
        } else if (id) {
          resultCtx.pendingResults.set(id, result);
          debug(
            `provider: queued result [${id}] (${resultCtx.pendingResults.size} pending)`,
          );
        } else {
          debug(`WARNING: tool result without toolCallId, cannot match`);
        }
        if (
          resultCtx.pendingToolCalls.size > 0 &&
          resultCtx.pendingResults.size > 0
        ) {
          debug(
            `BUG: both maps non-empty! handlers=${resultCtx.pendingToolCalls.size} results=${resultCtx.pendingResults.size}`,
          );
        }
      }
      if (resultCtx.pendingToolCalls.size > 0) {
        debug(
          `WARNING: ${resultCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`,
        );
        runtime.ui?.notify(
          `Claude bridge: ${resultCtx.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`,
          "warning",
        );
      }

      if (lastMsgRole === "user" || lastMsgRole === "developer") {
        const userPrompt = extractUserPrompt(context.messages);
        if (userPrompt) {
          resultCtx.deferredUserMessages.push(userPrompt);
          debug(
            `provider: deferred user message for replay after query: ${userPrompt.slice(0, 60)}`,
          );
        }
      }

      sessions.advanceCursor(context.messages.length);
      resultCtx.latestCursor = Math.max(
        resultCtx.latestCursor,
        context.messages.length,
      );
      return stream;
    }

    // --- Orphaned tool result ---
    const lastMsg = context.messages[context.messages.length - 1];
    if (lastMsg?.role === "toolResult") {
      debug(`provider: orphaned tool result after abort, emitting end_turn`);
      sessions.advanceCursor(context.messages.length);
      const c = ctx();
      queueMicrotask(() => {
        c.resetTurnState(model);
        stream.push({
          type: "done",
          reason: "stop",
          message: c.turnOutput,
        });
        markStreamComplete(stream);
        stream.end();
      });
      return stream;
    }

    // --- Fresh query ---
    const isReentrant = activeQuery;
    const queryCtx = isReentrant ? new QueryContext() : ctx();
    debug(
      `provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`,
    );

    claimCurrentPiStream(stream, "fresh-query", queryCtx);
    queryCtx.pendingToolCalls.clear();
    queryCtx.pendingResults.clear();
    queryCtx.deferredUserMessages = [];
    queryCtx.resetTurnState(model);
    queryCtx.latestCursor = 0;

    const { mcpTools, customToolNameToSdk, customToolNameToPi } =
      resolveMcpTools(context, runtime.askClaudeToolName);
    const cwd =
      (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const syncResult = sessions.sync(
      context.messages,
      cwd,
      customToolNameToSdk,
      model.id,
    );
    const { sessionId: resumeSessionId } = syncResult;
    const promptBlocks = extractUserPromptBlocks(context.messages);
    let promptText = extractUserPrompt(context.messages) ?? "";

    if (!promptText && !promptBlocks) {
      diagDump("empty_prompt", {
        contextLength: context.messages.length,
        lastMsgRole: lastMsg?.role,
        isReentrant,
        activeQueryContexts: activeQueryContexts.size,
        activeQueryExists: queryCtx.activeQuery !== null,
        sharedSession: sessions.current
          ? {
              sessionId: sessions.current.sessionId.slice(0, 8),
              cursor: sessions.current.cursor,
            }
          : null,
        messageRoles: context.messages
          .map((m, i) => `[${i}]${m.role}`)
          .join(" "),
      });
      promptText = "[continue]";
    }

    const prompt: string | AsyncIterable<SDKUserMessage> = promptBlocks
      ? wrapPromptStream(promptBlocks)
      : promptText;

    const mcpServers = buildMcpServers(mcpTools, queryCtx);
    const appendSystemPrompt =
      runtime.providerSettings.appendSystemPrompt !== false;

    const systemPromptAppend = buildSystemPromptAppend(
      appendSystemPrompt,
      context.systemPrompt as string | string[] | undefined,
    );

    const settingSources: SettingSource[] | undefined = appendSystemPrompt
      ? undefined
      : runtime.providerSettings.settingSources ?? ["user", "project"];
    const strictMcpConfigEnabled =
      runtime.providerSettings.strictMcpConfig !== false;
    const claudeExecutable =
      runtime.providerSettings.pathToClaudeCodeExecutable;
    const cliSettings = runtime.providerSettings.settings;

    const effort = options?.reasoning
      ? ((model.thinkingLevelMap?.[options.reasoning] as
          | EffortLevel
          | undefined) ?? REASONING_TO_EFFORT[options.reasoning])
      : undefined;

    const cliModel = claudeCodeModelId(model, runtime.longContextSettings);
    const extraArgs: Record<string, string | null> = { model: cliModel };
    if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
    if (effort) extraArgs["thinking-display"] = "summarized";

    const childEnv = {
      ...process.env,
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
    };
    const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
      cwd,
      env: childEnv,
      tools: [],
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemPromptAppend ? systemPromptAppend : undefined,
      },
      extraArgs,
      ...(effort ? { effort } : {}),
      ...(settingSources ? { settingSources } : {}),
      ...(cliSettings ? { settings: cliSettings } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(claudeExecutable
        ? { pathToClaudeCodeExecutable: claudeExecutable }
        : {}),
      ...makeCliDebugOptions("provider"),
    };

    debug(
      "provider: fresh query",
      `model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
      `resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
      `appendSys=${appendSystemPrompt} strictMcp=${strictMcpConfigEnabled}`,
      `prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`,
    );

    let wasAborted = false;
    const sdkQuery: Query = runtime.queryFn({ prompt, options: queryOptions });
    queryCtx.activeQuery = sdkQuery;
    activeQueryContexts.add(queryCtx);

    const abortCtx = queryCtx;

    const requestAbort = () => {
      void sdkQuery.interrupt().catch(() => {});
      try {
        sdkQuery.close();
      } catch {}
    };
    const onAbort = () => {
      wasAborted = true;
      abortCtx.deferredUserMessages = [];
      for (const pending of abortCtx.pendingToolCalls.values()) {
        pending.resolve({
          content: [{ type: "text", text: "Operation aborted" }],
        });
      }
      abortCtx.pendingToolCalls.clear();
      abortCtx.pendingResults.clear();
      requestAbort();
    };
    if (options?.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const notifyHook = {
      notify: (message: string, level: "warning" | "error") =>
        runtime.ui?.notify(message, level),
    };

    consumeQuery(
      sdkQuery,
      customToolNameToPi,
      model,
      () => wasAborted,
      queryCtx,
      notifyHook,
    )
      .then(async ({ capturedSessionId }) => {
        debug(
          `provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`,
        );

        if (wasAborted || options?.signal?.aborted) {
          sessions.markAborted();
          queryCtx.deferredUserMessages = [];
          debug(
            `provider: abort detected, marked sharedSession needsRebuild + forceRotate`,
          );
          if (queryCtx.turnOutput) {
            queryCtx.turnOutput.stopReason = "aborted";
            queryCtx.turnOutput.errorMessage = "Operation aborted";
          }
          const abortedStream = queryCtx.currentPiStream;
          abortedStream?.push({
            type: "error",
            reason: "aborted",
            error: queryCtx.turnOutput!,
          });
          markStreamComplete(abortedStream);
          abortedStream?.end();
          queryCtx.currentPiStream = null;
          return;
        }

        const sessionId = capturedSessionId ?? sessions.current?.sessionId;
        if (syncResult.preserveSharedSession) {
          if (
            capturedSessionId &&
            capturedSessionId !== sessions.current?.sessionId
          ) {
            deleteSession(
              capturedSessionId,
              cwd,
              process.env.CLAUDE_CONFIG_DIR,
            );
            debug(
              `provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`,
            );
          }
          debug(
            `provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`,
          );
        } else if (sessionId) {
          const cursor = Math.max(
            context.messages.length,
            queryCtx.latestCursor,
            sessions.current?.cursor ?? 0,
          );
          debug(
            `provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`,
          );
          sessions.commit(sessionId, cursor, cwd);
        }

        // Replay deferred user messages as continuation queries
        try {
          while (
            queryCtx.deferredUserMessages.length > 0 &&
            !isReentrant &&
            !wasAborted
          ) {
            const steerPrompt = queryCtx.deferredUserMessages.shift()!;
            debug(
              `provider: replaying deferred user message: ${steerPrompt.slice(0, 60)}`,
            );
            queryCtx.resetTurnState(model);

            const resumeId = sessions.current?.sessionId;
            if (!resumeId) {
              debug(
                `WARNING: no session to resume for deferred message, dropping`,
              );
              break;
            }

            const contOptions = {
              ...queryOptions,
              resume: resumeId,
              ...makeCliDebugOptions("continuation"),
            };
            const contQuery = runtime.queryFn({
              prompt: steerPrompt,
              options: contOptions,
            });
            queryCtx.activeQuery = contQuery;

            debug(
              `provider: continuation query, model=${cliModel}, resume=${resumeId.slice(0, 8)}, prompt=${steerPrompt.slice(0, 60)}`,
            );

            try {
              const { capturedSessionId: contSid } = await consumeQuery(
                contQuery,
                customToolNameToPi,
                model,
                () => wasAborted,
                queryCtx,
                notifyHook,
              );
              const sid = contSid ?? sessions.current?.sessionId;
              if (sid) {
                sessions.commit(sid, sessions.current?.cursor ?? 0, cwd);
              }
            } catch (contError) {
              debug(`provider: continuation query error:`, contError);
              break;
            } finally {
              contQuery.close();
            }
          }
        } finally {
          queryCtx.activeQuery = sdkQuery;
        }

        if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
          debug(
            "provider: clearing activeQuery before final stream completion",
          );
          queryCtx.activeQuery = null;
        }
        finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
      })
      .catch((error) => {
        debug(
          `provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`,
          error,
        );
        if (wasAborted || options?.signal?.aborted) {
          sessions.markAborted();
        } else {
          sessions.clear();
        }
        queryCtx.deferredUserMessages = [];
        if (queryCtx.turnOutput) {
          queryCtx.turnOutput.stopReason = options?.signal?.aborted
            ? "aborted"
            : "error";
          queryCtx.turnOutput.errorMessage =
            error instanceof Error ? error.message : String(error);
        }
        if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
          for (const pending of queryCtx.pendingToolCalls.values()) {
            pending.resolve({
              content: [{ type: "text", text: "Query ended" }],
            });
          }
          queryCtx.pendingToolCalls.clear();
          queryCtx.pendingResults.clear();
          debug(
            "provider: clearing activeQuery before error stream completion",
          );
          queryCtx.activeQuery = null;
        }
        const errorStream = queryCtx.currentPiStream;
        errorStream?.push({
          type: "error",
          reason: (queryCtx.turnOutput?.stopReason ?? "error") as
            | "aborted"
            | "error",
          error: queryCtx.turnOutput!,
        });
        markStreamComplete(errorStream);
        errorStream?.end();
        queryCtx.currentPiStream = null;
      })
      .finally(() => {
        if (options?.signal)
          options.signal.removeEventListener("abort", onAbort);
        if (queryCtx.activeQuery === sdkQuery) {
          for (const pending of queryCtx.pendingToolCalls.values()) {
            pending.resolve({
              content: [{ type: "text", text: "Query ended" }],
            });
          }
          queryCtx.pendingToolCalls.clear();
          queryCtx.pendingResults.clear();
          queryCtx.activeQuery = null;
        }
        activeQueryContexts.delete(queryCtx);
        sdkQuery.close();
      });

    return stream;
  };
}
