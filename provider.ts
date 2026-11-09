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
import { QueryContext, ctx, replaceContext } from "./query-state.js";
import { latestHistoryRewrite } from "./session-store.js";
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

/**
 * Prompt of a query restarted after omp compacted its history mid-run. The
 * session ends on the tool results the old query was waiting for; Claude Code
 * still needs a user turn to start.
 */
export const COMPACTION_RESUME_PROMPT =
  "<system-reminder>The conversation history was compacted while you were working. The tool result above is the latest one. Continue the task from where you left off; do not redo finished steps.</system-reminder>";

export type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function createStreamClaudeAgentSdk(
  runtime: BridgeRuntime,
): StreamSimpleFn {
  // Process-wide, not per provider instance: a subagent loading the extension
  // re-registers the provider mid-run, and the main session's next tool result
  // reaches that new instance. With a set of its own, it found no query waiting
  // for the result, ended the turn empty, and left the main query hanging.
  const activeQueryContexts: Set<QueryContext> = runtime.activeQueryContexts;

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
    const ompSessionId = (options as { sessionId?: string } | undefined)
      ?.sessionId;
    // This omp session's state: the main session and its subagents no longer
    // share (and evict) one Claude session, and /clear (a new id) starts fresh.
    const sessions = runtime.sessions.for(ompSessionId);

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

    // --- Restart after a mid-run history rewrite ---
    // omp compacted its history between two provider calls of a run. Handing
    // these tool results to the running Claude Code query would keep its full
    // context: the compaction would change nothing for Claude, and omp would
    // compact again on every call. Stop that query instead and start a new one
    // on a Claude session rebuilt from the compacted history.
    const contextRewriteAt = latestHistoryRewrite(context.messages);
    const restartFrom =
      resultCtx &&
      !resultCtx.ephemeral &&
      contextRewriteAt !== undefined &&
      contextRewriteAt > (resultCtx.builtRewriteAt ?? Number.NEGATIVE_INFINITY)
        ? resultCtx
        : undefined;
    let restartWasMain = false;
    let carriedUserMessages: string[] = [];
    if (restartFrom) {
      restartWasMain = ctx() === restartFrom;
      const oldQuery = restartFrom.activeQuery as Query | null;
      debug(
        `provider: omp rewrote its history mid-run (historyRewriteAt=${contextRewriteAt}, query built with ${restartFrom.builtRewriteAt ?? "none"}): restarting the query, ${restartFrom.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`,
      );
      restartFrom.superseded = true;
      carriedUserMessages = restartFrom.deferredUserMessages;
      restartFrom.deferredUserMessages = [];
      restartFrom.currentPiStream = null;
      for (const pending of restartFrom.pendingToolCalls.values()) {
        pending.resolve({
          content: [
            { type: "text", text: "Superseded: history compacted, query restarted" },
          ],
        });
      }
      restartFrom.pendingToolCalls.clear();
      restartFrom.pendingResults.clear();
      restartFrom.activeQuery = null;
      activeQueryContexts.delete(restartFrom);
      void oldQuery?.interrupt().catch(() => {});
      try {
        oldQuery?.close();
      } catch {}
    }

    // --- Tool result delivery ---
    if (resultCtx && !restartFrom) {
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

      if (!resultCtx.ephemeral) sessions.advanceCursor(context.messages.length);
      resultCtx.latestCursor = Math.max(
        resultCtx.latestCursor,
        context.messages.length,
      );
      return stream;
    }

    // --- Orphaned tool result ---
    const lastMsg = context.messages[context.messages.length - 1];
    if (!restartFrom && lastMsg?.role === "toolResult") {
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
    // A restarted query takes the old one's place: the main context when the
    // old query was the main one, so deferred user messages still replay.
    const isReentrant = restartFrom ? !restartWasMain : activeQuery;
    const queryCtx =
      restartFrom || isReentrant ? new QueryContext() : ctx();
    if (restartFrom && restartWasMain) replaceContext(restartFrom, queryCtx);
    debug(
      `provider: fresh query setup, isReentrant=${isReentrant}, restart=${Boolean(restartFrom)}, activeContexts=${activeQueryContexts.size}`,
    );

    claimCurrentPiStream(stream, "fresh-query", queryCtx);
    queryCtx.pendingToolCalls.clear();
    queryCtx.pendingResults.clear();
    queryCtx.deferredUserMessages = carriedUserMessages;
    queryCtx.resetTurnState(model);
    queryCtx.latestCursor = 0;
    queryCtx.builtRewriteAt = contextRewriteAt;

    const { mcpTools, customToolNameToSdk, customToolNameToPi } =
      resolveMcpTools(context, runtime.askClaudeToolName);
    const cwd =
      (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    // A side-channel call (title request) shares its parent session's store
    // but runs on a throwaway Claude session. /clear needs nothing here any
    // more: it rotates the omp session id, which selects a fresh store.
    const isSideChannel =
      typeof ompSessionId === "string" && ompSessionId.includes(":side:");
    const syncResult = isSideChannel
      ? sessions.syncEphemeral(
          context.messages,
          cwd,
          customToolNameToSdk,
          model.id,
        )
      : sessions.sync(context.messages, cwd, customToolNameToSdk, model.id, {
          // Also when reentrant: query state is process-wide, so a query left
          // open elsewhere (a subagent's) makes every main call look reentrant.
          // The rebuild goes to a new session, so it never races that query.
          detectHistoryRewrite: true,
          // Restarted on tool results: they go into the new session, and the
          // query starts on COMPACTION_RESUME_PROMPT. Restarted on a user
          // message (a steer came with the results): that message is the
          // prompt, as for any fresh query.
          restartAfterRewrite:
            Boolean(restartFrom) && lastMsgRole === "toolResult",
        });
    queryCtx.ephemeral = Boolean(syncResult.preserveSharedSession);
    const { sessionId: resumeSessionId } = syncResult;
    const resumeAfterRewrite =
      Boolean(restartFrom) && lastMsgRole === "toolResult";
    const promptBlocks = resumeAfterRewrite
      ? null
      : extractUserPromptBlocks(context.messages);
    let promptText = resumeAfterRewrite
      ? COMPACTION_RESUME_PROMPT
      : (extractUserPrompt(context.messages) ?? "");

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
        if (queryCtx.superseded) {
          debug(
            `provider: superseded query ended (session ${capturedSessionId?.slice(0, 8) ?? "?"}), state left to the restarted one`,
          );
          return;
        }

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
          sessions.commit(sessionId, cursor, cwd, ompSessionId);
        }

        // Replay deferred user messages as continuation queries
        try {
          while (
            queryCtx.deferredUserMessages.length > 0 &&
            !isReentrant &&
            !wasAborted &&
            !queryCtx.superseded
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
              // Restarted while this continuation ran: its session is stale.
              if (queryCtx.superseded) break;
              const sid = contSid ?? sessions.current?.sessionId;
              if (sid) {
                sessions.commit(
                  sid,
                  sessions.current?.cursor ?? 0,
                  cwd,
                  sessions.current?.ompSessionId ?? ompSessionId,
                );
              }
            } catch (contError) {
              debug(`provider: continuation query error:`, contError);
              break;
            } finally {
              contQuery.close();
            }
          }
        } finally {
          queryCtx.activeQuery = queryCtx.superseded ? null : sdkQuery;
        }
        if (queryCtx.superseded) return;

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
        // Interrupted on purpose for a restart: the error is expected, and
        // clearing or marking the session would hit the restarted query's.
        if (queryCtx.superseded) return;
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
