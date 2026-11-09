// oh-my-pi claude-bridge extension entry point: config load, session
// lifecycle hooks, provider + AskClaude tool registration. All logic lives in
// the sibling modules (see AGENTS.md file map).
// Ported from pi-claude-bridge. Uses @earendil-works/* import paths
// (oh-my-pi's compat shim rewrites them at load time).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debug } from "./debug.js";
import { PROVIDER_ID } from "./convert.js";
import { MODELS, applyLongContext } from "./models.js";
import { loadConfig } from "./config.js";
import { sharedRuntime } from "./runtime.js";
import { createStreamClaudeAgentSdk } from "./provider.js";
import { registerAskClaudeTool } from "./askclaude.js";
import { toPromptArray } from "./prompt.js";

export default function (pi: ExtensionAPI) {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const config = loadConfig(process.cwd());
  debug("loadConfig:", JSON.stringify(config));

  // Every load (one per subagent session) shares the process-wide runtime.
  const runtime = sharedRuntime();
  runtime.providerSettings = config.provider ?? {};
  runtime.longContextSettings = {
    plan: runtime.providerSettings.plan ?? "pro",
    longContextExtraUsage:
      runtime.providerSettings.longContextExtraUsage ?? false,
  };
  runtime.askClaudeToolName = config.askClaude?.name ?? "AskClaude";

  const registeredModels = applyLongContext(MODELS, runtime.longContextSettings);
  const streamClaudeAgentSdk = createStreamClaudeAgentSdk(runtime);

  // The omp session a hook fires for: hooks touch that session's state only,
  // never another session's (a subagent's session_start used to wipe the main
  // session's). Fakes without a sessionManager map to the "" key.
  const sessionIdOf = (ctx: unknown): string | undefined =>
    (
      ctx as
        | { sessionManager?: { getSessionId?: () => string } }
        | undefined
    )?.sessionManager?.getSessionId?.();

  const clearSession = (event: string, ctx: unknown) => {
    const id = sessionIdOf(ctx);
    debug(
      `clearSession ${event} (omp ${id ?? "?"}): clearing session ${runtime.sessions.get(id)?.current?.sessionId?.slice(0, 8) ?? "none"}`,
    );
    runtime.sessions.delete(id);
  };

  // oh-my-pi SessionStartEvent has no `reason` field — clear unconditionally
  pi.on("session_start", (_event, ctx) => {
    runtime.ui = ctx.ui;
    // getSystemPrompt()'s published return type is `string`, but oh-my-pi's
    // runtime returns `string[]`; toPromptArray accepts either.
    runtime.cachedSystemPrompt = toPromptArray(ctx.getSystemPrompt());
    clearSession("session_start", ctx);
  });
  pi.on("session_shutdown", (_event, ctx) =>
    clearSession("session_shutdown", ctx),
  );

  // Compaction takeover skipped — let oh-my-pi's default compaction handle it.
  // See plan: Decision 1 in the port plan.

  // oh-my-pi SessionCompactEvent has `compactionEntry` not `reason`/`willRetry`
  const markRebuild = (event: string, ctx: unknown) => {
    const store = runtime.sessions.get(sessionIdOf(ctx));
    if (store?.current) {
      debug(
        `${event}: marking needsRebuild on session ${store.current.sessionId.slice(0, 8)}`,
      );
      store.markRebuild();
    }
  };
  pi.on("session_compact", (_event, ctx) =>
    markRebuild("session_compact", ctx),
  );
  pi.on("session_tree", (_event, ctx) => markRebuild("session_tree", ctx));

  // --- Provider ---
  // Always register, even when another bridge instance already did: oh-my-pi's
  // createAgentSession wipes each extension source's provider registrations
  // before flushing the ones queued by the freshly loaded instance
  // (clear-then-flush). Skipping registration on re-load (the old
  // ACTIVE_STREAM_SIMPLE_KEY guard) left the shared ModelRegistry without
  // claude-bridge whenever a subagent session loaded this extension while the
  // guard was set — surfacing as "No API key for provider: claude-bridge".
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "claude-bridge",
    apiKey: "not-used",
    api: "claude-bridge",
    models: registeredModels,
    streamSimple: streamClaudeAgentSdk,
  });

  // --- AskClaude tool ---
  if (config.askClaude?.enabled !== false) {
    registerAskClaudeTool(pi, runtime, config);
  }

  // Returned for testability (index.test.ts inspects lifecycle effects). oh-my-pi
  // ignores the return value of an extension entry.
  return runtime;
}
