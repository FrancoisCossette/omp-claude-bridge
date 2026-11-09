// Shared mutable bridge state, previously scattered module-level globals in
// index.ts. One per process (sharedRuntime): omp loads the extension again for
// every subagent session and routes every claude-bridge call of the process to
// the provider registered last, so state kept per load ends up split between
// the instance that started a query and the one that receives its tool results.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import type { LongContextSettings } from "./models.js";
import type { QueryContext } from "./query-state.js";
import { SessionRegistry } from "./session-store.js";

/** The Claude Agent SDK `query` entry point; injectable so provider.ts and
 *  askclaude.ts orchestration can be driven by a scripted fake in tests. */
export type QueryFn = typeof query;

export interface BridgeRuntime {
  providerSettings: NonNullable<Config["provider"]>;
  longContextSettings: LongContextSettings;
  /** Claude session state, one store per omp session. */
  sessions: SessionRegistry;
  /** Queries in flight, whichever provider instance started them. */
  activeQueryContexts: Set<QueryContext>;
  ui: ExtensionUIContext | null;
  askClaudeToolName: string;
  /** Cached because oh-my-pi's CustomToolContext lacks getSystemPrompt. */
  cachedSystemPrompt: string[];
  queryFn: QueryFn;
}

export function createRuntime(): BridgeRuntime {
  const runtime: BridgeRuntime = {
    providerSettings: {},
    longContextSettings: { plan: "pro", longContextExtraUsage: false },
    sessions: new SessionRegistry((message, level) =>
      runtime.ui?.notify(message, level),
    ),
    activeQueryContexts: new Set<QueryContext>(),
    ui: null,
    askClaudeToolName: "AskClaude",
    cachedSystemPrompt: [],
    queryFn: query,
  };
  return runtime;
}

const SHARED_RUNTIME = Symbol.for("omp-claude-bridge.runtime");
type RuntimeHolder = { [SHARED_RUNTIME]?: BridgeRuntime };

/** The process-wide runtime every load of the extension shares. */
export function sharedRuntime(): BridgeRuntime {
  const holder = globalThis as RuntimeHolder;
  return (holder[SHARED_RUNTIME] ??= createRuntime());
}

/** Test-only: forget the process-wide runtime. */
export function resetSharedRuntime(): void {
  delete (globalThis as RuntimeHolder)[SHARED_RUNTIME];
}
