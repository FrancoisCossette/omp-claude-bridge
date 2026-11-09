// AskClaude tool: headless delegation to Claude Code from other providers.
// Ported from pi-claude-bridge verbatim, parameterized by BridgeRuntime.

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type SDKMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { Context } from "@earendil-works/pi-ai";
import { debug, makeCliDebugOptions } from "./debug.js";
import { MODELS, claudeCodeModelId, resolveModel } from "./models.js";
import { extractSkillsBlock } from "./skills.js";
import { REASONING_TO_EFFORT, mapToolName } from "./tool-mapping.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import type { Config } from "./config.js";
import type { BridgeRuntime } from "./runtime.js";

// Plan-mode/interactive-only tools: AskClaude runs headless with no way to
// surface these to the omp user.
export const ASKCLAUDE_ALWAYS_BLOCKED = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "ToolSearch",
  "ScheduleWakeup",
];

export const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
  full: [...ASKCLAUDE_ALWAYS_BLOCKED],
  read: [
    ...ASKCLAUDE_ALWAYS_BLOCKED,
    "Write",
    "Edit",
    "Bash",
    "NotebookEdit",
    "EnterWorktree",
    "ExitWorktree",
    "CronCreate",
    "CronDelete",
    "TeamCreate",
    "TeamDelete",
  ],
  none: [
    ...ASKCLAUDE_ALWAYS_BLOCKED,
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "Agent",
    "NotebookEdit",
    "EnterWorktree",
    "ExitWorktree",
    "CronCreate",
    "CronDelete",
    "TeamCreate",
    "TeamDelete",
    "WebFetch",
    "WebSearch",
  ],
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    try {
      return JSON.stringify(err);
    } catch {}
  }
  return String(err);
}

export interface PromptAndWaitOptions {
  systemPrompt?: string;
  appendSkills?: boolean;
  onStreamUpdate?: (responseText: string) => void;
  model?: string;
  thinking?: string;
  isolated?: boolean;
  context?: Context["messages"];
  /** omp session the call comes from; selects its Claude session state. */
  ompSessionId?: string;
}

export async function promptAndWait(
  runtime: BridgeRuntime,
  prompt: string,
  mode: "full" | "read" | "none",
  toolCalls: Map<string, ToolCallState>,
  signal?: AbortSignal,
  options?: PromptAndWaitOptions,
): Promise<{ responseText: string; stopReason: string }> {
  const cwd = process.cwd();
  const requestedModel = options?.model ?? "opus";
  const model = resolveModel(MODELS, requestedModel);
  const modelId = model?.id ?? requestedModel;
  const cliModel = model
    ? claudeCodeModelId(model, runtime.longContextSettings)
    : modelId;

  let resumeSessionId: string | null = null;
  if (!options?.isolated && options?.context?.length) {
    const sessions = runtime.sessions.for(options.ompSessionId);
    if (sessions.current) {
      resumeSessionId = sessions.current.sessionId;
    } else {
      const contextWithPrompt = [
        ...options.context,
        {
          role: "user" as const,
          content: prompt,
          timestamp: Date.now(),
        },
      ];
      const sync = sessions.sync(
        contextWithPrompt as Context["messages"],
        cwd,
        undefined,
        modelId,
      );
      resumeSessionId = sync.sessionId;
    }
  }

  const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

  const skillsBlock =
    options?.appendSkills !== false && options?.systemPrompt
      ? extractSkillsBlock(options.systemPrompt)
      : undefined;

  const effort =
    options?.thinking && options.thinking !== "off"
      ? REASONING_TO_EFFORT[options.thinking]
      : undefined;

  const claudeExecutable = runtime.providerSettings.pathToClaudeCodeExecutable;

  const extraArgs: Record<string, string | null> = {
    "strict-mcp-config": null,
    model: cliModel,
  };
  if (effort) extraArgs["thinking-display"] = "summarized";

  debug(
    "askClaude:",
    `mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
    `isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
    `skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`,
  );

  const sdkQuery = runtime.queryFn({
    prompt,
    options: {
      cwd,
      env: {
        ...process.env,
        ENABLE_CLAUDEAI_MCP_SERVERS: "0",
        DISABLE_AUTO_COMPACT: "1",
      },
      permissionMode: "bypassPermissions",
      ...(disallowedTools.length ? { disallowedTools } : {}),
      ...(effort ? { effort } : {}),
      systemPrompt: skillsBlock
        ? { type: "preset", preset: "claude_code", append: skillsBlock }
        : undefined,
      settingSources: ["user", "project"] as SettingSource[],
      extraArgs,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(options?.isolated ? { persistSession: false } : {}),
      ...(claudeExecutable
        ? { pathToClaudeCodeExecutable: claudeExecutable }
        : {}),
      ...makeCliDebugOptions("askclaude"),
    },
  });

  let wasAborted = false;
  const onAbort = () => {
    wasAborted = true;
    sdkQuery.interrupt().catch(() => {
      try {
        sdkQuery.close();
      } catch {}
    });
  };
  if (signal?.aborted) {
    onAbort();
    throw new Error("Aborted");
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  let responseText = "";
  let sdkMessageCount = 0;
  let textDeltaCount = 0;
  let resultSubtype: string | undefined;

  try {
    for await (const message of sdkQuery) {
      if (wasAborted) break;
      sdkMessageCount++;

      switch (message.type) {
        case "stream_event": {
          const event = (message as SDKMessage & {
            event?: {
              type?: string;
              delta?: { type?: string; text?: string };
              content_block?: { type?: string; id?: string; name?: string };
            };
          }).event;
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            responseText += event.delta.text;
            textDeltaCount++;
            options?.onStreamUpdate?.(responseText);
          }
          if (
            event?.type === "content_block_start" &&
            event.content_block?.type === "tool_use"
          ) {
            debug(`askClaude: tool_use start: ${event.content_block.name}`);
            toolCalls.set(event.content_block.id!, {
              name: mapToolName(event.content_block.name!),
              status: "running",
            });
          }
          break;
        }
        case "assistant": {
          const content = (message as unknown as {
            message?: {
              content?: Array<{
                type: string;
                id?: string;
                name?: string;
                input?: unknown;
              }>;
            };
          }).message?.content;
          for (const block of content ?? []) {
            if (block.type === "tool_use") {
              toolCalls.set(block.id!, {
                name: mapToolName(block.name!),
                status: "complete",
                rawInput: block.input,
              });
            }
          }
          break;
        }
        case "result": {
          resultSubtype = message.subtype;
          const r = message as unknown as {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            num_turns?: number;
          };
          if (r.usage) {
            debug(
              `askClaude: result usage: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens ?? 0} cacheWrite=${r.usage.cache_creation_input_tokens ?? 0} turns=${r.num_turns ?? "?"}`,
            );
          }
          if (
            !responseText &&
            message.subtype === "success" &&
            message.result
          ) {
            responseText = message.result;
          }
          break;
        }
      }
    }

    const stopReason = wasAborted ? "cancelled" : "stop";
    debug(
      "askClaude: done",
      `stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
      `sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
      `toolCalls=${toolCalls.size}`,
    );
    return { responseText, stopReason };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    sdkQuery.close();
  }
}

// --- Tool registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL =
  "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION =
  "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

interface AskClaudeDetails {
  prompt?: string;
  executionTime?: number;
  actions?: string;
  error?: boolean;
}

export function registerAskClaudeTool(
  pi: ExtensionAPI,
  runtime: BridgeRuntime,
  config: Config,
): void {
  const askConf = config.askClaude;
  const allowFull = askConf?.allowFullMode !== false;
  const defaultMode = askConf?.defaultMode ?? "read";
  const defaultIsolated = askConf?.defaultIsolated ?? false;

  const modeValues = allowFull
    ? (["read", "full", "none"] as const)
    : (["read", "none"] as const);
  let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
  if (allowFull)
    modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

  const askClaudeParams = Type.Object({
    prompt: Type.String({
      description:
        "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore.",
    }),
    mode: Type.Optional(
      StringEnum(modeValues as unknown as string[], { description: modeDesc }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".',
      }),
    ),
    thinking: Type.Optional(
      StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
        description: "Thinking effort level. Omit to use Claude Code's default.",
      }),
    ),
    isolated: Type.Optional(
      Type.Boolean({
        description:
          "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history.",
      }),
    ),
  });
  type AskClaudeParams = Static<typeof askClaudeParams>;

  // Get keyHint for renderResult. Try pi-utils import path pattern.
  let hint: ((id: string, label: string) => string) | undefined;
  try {
    const piUtils = (pi as unknown as {
      pi?: { keyHint?: (id: string, label: string) => string };
    }).pi;
    hint = piUtils?.keyHint;
  } catch {}

  pi.registerTool<typeof askClaudeParams, AskClaudeDetails>({
    name: askConf?.name ?? "AskClaude",
    label: askConf?.label ?? "Ask Claude Code",
    description:
      askConf?.description ??
      (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
    parameters: askClaudeParams,
    renderCall(args: AskClaudeParams, theme: Theme) {
      let text = theme.fg("mdLink", theme.bold("AskClaude "));
      const mode = args.mode ?? defaultMode;
      const tags: string[] = [];
      if (mode !== defaultMode) tags.push(`mode=${mode}`);
      if (args.model) tags.push(`model=${args.model}`);
      if (args.thinking) tags.push(`thinking=${args.thinking}`);
      if (args.isolated) tags.push("isolated");
      if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
      const truncated =
        args.prompt.length > PREVIEW_MAX_CHARS
          ? args.prompt.substring(0, PREVIEW_MAX_CHARS)
          : args.prompt;
      const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
      text += theme.fg("muted", `"${lines.join("\n")}"`);
      if (
        args.prompt.length > PREVIEW_MAX_CHARS ||
        args.prompt.split("\n").length > PREVIEW_MAX_LINES
      )
        text += theme.fg("dim", " …");
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }: ToolRenderResultOptions, theme: Theme) {
      if (isPartial) {
        const status =
          result.content[0]?.type === "text"
            ? result.content[0].text
            : "working...";
        return new Text(
          theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status),
          0,
          0,
        );
      }

      const details = result.details;
      const body =
        result.content[0]?.type === "text" ? result.content[0].text : "";

      let text = details?.error
        ? theme.fg("error", "✗ Claude Code error")
        : theme.fg("mdLink", "✓ Claude Code");

      if (details?.executionTime)
        text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
      if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

      if (expanded) {
        if (details?.prompt)
          text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
        if (details?.prompt && body)
          text += `\n${theme.fg("dim", "─".repeat(40))}`;
        if (body) text += `\n${theme.fg("toolOutput", body)}`;
      } else {
        const truncated =
          body.length > PREVIEW_MAX_CHARS
            ? body.substring(0, PREVIEW_MAX_CHARS)
            : body;
        const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
        if (lines.length)
          text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
        if (
          body.length > PREVIEW_MAX_CHARS ||
          body.split("\n").length > PREVIEW_MAX_LINES
        )
          text += `\n${theme.fg("dim", `… (${hint ? hint("app.tools.expand", "to expand") : "to expand"})`)}`;
      }

      return new Text(text, 0, 0);
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      // Guard: circular delegation
      if (ctx.model?.baseUrl === "claude-bridge") {
        debug(
          "askClaude: blocked circular delegation (active provider is claude-bridge)",
        );
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code.",
            },
          ],
          details: { error: true },
        };
      }

      const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
      const isolated = params.isolated ?? defaultIsolated;
      const toolCalls = new Map<string, ToolCallState>();
      const start = Date.now();

      const progressInterval = setInterval(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        const summary = buildActionSummary(toolCalls);
        const status = summary
          ? `${elapsed}s — ${summary}`
          : `${elapsed}s — working...`;
        onUpdate?.({
          content: [{ type: "text", text: status }],
          details: {
            prompt: params.prompt,
            executionTime: Date.now() - start,
          },
        });
      }, 1000);

      try {
        // oh-my-pi: always isolated. CustomToolContext lacks getSystemPrompt
        // and SessionEntry[] → Message[] conversion is non-trivial.
        // Context is always undefined. isolated param still controls persistSession.
        const systemPromptStr = runtime.cachedSystemPrompt.join("\n\n");
        const result = await promptAndWait(
          runtime,
          params.prompt,
          mode,
          toolCalls,
          signal,
          {
            systemPrompt: systemPromptStr,
            appendSkills: askConf?.appendSkills,
            model: params.model,
            thinking: params.thinking,
            isolated,
            context: undefined,
            ompSessionId: (
              ctx as { sessionManager?: { getSessionId?: () => string } }
            ).sessionManager?.getSessionId?.(),
          },
        );
        clearInterval(progressInterval);
        onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
        const executionTime = Date.now() - start;
        const actions = buildActionSummary(toolCalls);

        const text = actions
          ? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
          : result.responseText;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            prompt: params.prompt,
            executionTime,
            actions,
          },
        };
      } catch (err) {
        clearInterval(progressInterval);
        debug(
          `askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`,
          err,
        );
        const msg = errorMessage(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          details: {
            prompt: params.prompt,
            executionTime: Date.now() - start,
            error: true,
          },
        };
      }
    },
  });
}
