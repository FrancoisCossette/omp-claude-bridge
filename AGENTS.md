# AGENTS.md

Notes for agents working in this repo. User-facing docs (install, config, provider/tool usage) live in [README.md](README.md) — don't duplicate that here.

## What this is

An `oh-my-pi` (`omp`) extension bridging to Claude Code via `@anthropic-ai/claude-agent-sdk`. Two entry points share the same plumbing:

- **Provider** (`createStreamClaudeAgentSdk` in `provider.ts`) — registers `claude-bridge` as an omp model provider.
- **AskClaude tool** (`promptAndWait` + `registerAskClaudeTool` in `askclaude.ts`) — a delegation tool available to other providers.

It's a fork of [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge) (targets the `pi` agent), adapted to omp's extension API. Files/functions commented "Ported from pi-claude-bridge verbatim" should stay behaviorally identical to upstream unless omp's API forces a change — check upstream before diverging on those.

## File map

Entry point and orchestration:

- `index.ts` — thin entry: config load, `BridgeRuntime` construction, session lifecycle hooks, provider + tool registration. The provider is registered unconditionally on every extension load: oh-my-pi's `createAgentSession` clears each extension source's provider registrations before flushing the newly queued ones, so skipping re-registration (the old `ACTIVE_STREAM_SIMPLE_KEY` guard) stranded the shared ModelRegistry without claude-bridge when subagent sessions re-loaded the extension ("No API key for provider: claude-bridge", hit in ACP mode).
- `runtime.ts` — `BridgeRuntime`, the shared mutable state bag (provider settings, `SessionStore`, UI handle, cached system prompt, `askClaudeToolName`) threaded into the two entry points. Also holds `queryFn`, the injectable Claude Agent SDK `query` entry point (defaults to the real SDK import) — the single seam that lets `provider.ts`/`askclaude.ts` be driven by a scripted fake query in tests. Replaces the module-level globals the pre-refactor `index.ts` had.
- `provider.ts` — the provider orchestration: fresh-query setup, tool-result delivery to waiting MCP handlers, abort handling, deferred-user-message replay. Owns the `activeQueryContexts` set (closure state per `createStreamClaudeAgentSdk` call). Calls the SDK via `runtime.queryFn`.
- `askclaude.ts` — AskClaude tool: mode gating constants (`MODE_DISALLOWED_TOOLS`, `ASKCLAUDE_ALWAYS_BLOCKED`), `promptAndWait`, tool registration incl. TUI renderers. Calls the SDK via `runtime.queryFn`.

Supporting modules (pure or near-pure, unit-tested in `test/`):

- `convert.ts` — pi message array → Anthropic API format; pi→SDK tool name mapping (`PI_TO_SDK_TOOL_NAME`, falls back to `pascalCase`); steered-notice retagging (`STEERED_NOTICE_TAGS` → `<system-reminder>`).
- `tool-mapping.ts` — the reverse direction: SDK→pi tool names (`mapToolName`), arg key renames (`SDK_KEY_RENAMES`, `mapToolArgs`), reasoning→effort map.
- `session-store.ts` — `SessionStore` class: the shared CC session state + cursor-based sync (Cases 1–4, see gotchas). Wraps cc-session-io writes and post-write verification.
- `stream-processing.ts` — SDK stream events → pi `AssistantMessageEventStream` events: `processStreamEvent`, `processAssistantMessage` (non-streaming fallback), `consumeQuery`, usage accounting.
- `prompt.ts` — last-user-prompt extraction (`extractUserPrompt`/`extractUserPromptBlocks`), `TOOL_NAMING_CLARIFICATION` (truthful, non-enumerating mcp-prefix + absence-is-policy clarification), `extractSubagentPrompt` (forwards oh-my-pi's subagent ROLE/COMPLETION element), `toPromptArray` (normalizes the `string`-vs-`string[]` system-prompt type mismatch), system-prompt-append assembly.
- `mcp-bridge.ts` — `resolveMcpTools` (two-way name maps), `buildMcpServers` (handler queue plumbing), `contextForToolResults`.
- `models.ts` — hand-copied model catalog (from oh-my-pi's `models.json` anthropic entries at port time, zero import dependency on the catalog package) plus 1M-context eligibility logic.
- `config.ts` — `Config` type + loader for `~/.omp/agent/claude-bridge.json` / `.omp/claude-bridge.json`.
- `agents-md.ts` — finds and sanitizes AGENTS.md for forwarding to Claude Code as `CLAUDE.md`.
- `skills.ts` — extracts the skills listing from the system prompt for forwarding (pi's `<available_skills>` block, or omp 18's `<skills>` block with `skill://` loading instructions); MCP naming constants.
- `query-state.ts` — `QueryContext`, the per-query mutable state container, plus a stack for isolated/nested queries.
- `extract-tool-results.ts` — walks context tail to collect a turn's tool results as MCP content blocks.
- `typebox-to-zod.ts` — converts TypeBox/JSON-Schema tool params to Zod (Claude Agent SDK's MCP server wants Zod shapes).
- `session-verify.ts` — post-write sanity check on the JSONL session file.
- `askclaude-ui.ts` — status-line/action-summary rendering for the AskClaude tool's TUI output.
- `debug.ts` — `CLAUDE_BRIDGE_DEBUG` logging, diag dumps, CC CLI debug-file plumbing.

No build step (plain `.ts`, loaded directly by omp/Bun).

## Testing

`bun test` runs the unit suite in `test/` (one file per module). Tests pin the observable behavior of each module — message conversion output, session sync cases against a temp `CLAUDE_CONFIG_DIR`, emitted pi event sequences from a fake stream sink — not internal call sequences.

`provider.ts` and `askclaude.ts` orchestration are tested through the `runtime.queryFn` seam (`test/provider.test.ts`, `test/askclaude.test.ts`): a scripted async-iterable fake query yields SDK messages and exposes a controllable `interrupt`, so the fresh-query, tool-result-delivery, abort, and deferred-replay paths run without spawning the real Claude Agent SDK subprocess. `index.ts` registration/lifecycle wiring is pinned in `test/index.test.ts` against a fake `ExtensionAPI` (deleting the unconditional `pi.registerProvider` fails it). Note the provider's per-turn state lives on the module-global `ctx()` (query-state.ts) — call `resetStack()` in `beforeEach`/`afterEach` when testing it.

Run `bun run check` (typecheck + tests) before committing — there's no CI for this yet.

## Running / debugging

```sh
omp -e /path/to/omp-claude-bridge/index.ts
```

Set `CLAUDE_BRIDGE_DEBUG=1` for a play-by-play in `~/.omp/agent/claude-bridge.log` (every provider call, session-sync case taken, tool result delivery, CC stderr) and `~/.omp/agent/claude-bridge-diag.log` for structured dumps. When touching session sync or stream processing, this log is the fastest way to confirm which code path actually ran.

## Findings / gotchas

- **Session sync is cursor-based, not full-replay.** `SessionStore.sync` (session-store.ts) diffs the incoming message array against the cached cursor and picks one of four paths logged as `Case 1`–`Case 4`: clean start, reuse-as-is, rebuild-preserving-id, or rebuild-with-rotated-id (post-abort, to avoid racing an orphaned writer for the old session id). If you change message-array shape assumptions here, all four cases need re-checking, not just the common one — `test/session-store.test.ts` covers each.
- **omp's `options.sessionId` tells conversations apart.** omp rotates it on `/clear` (a `reset_boundary`: context emptied in place, no extension event) and suffixes side-channel calls (title requests and the like) with `:side:<hex>`. A main call with another id than the one committed with the shared session drops that session; a side-channel call gets its own throwaway session (`SessionStore.syncEphemeral`) and never touches the shared state. A throwaway query (`QueryContext.ephemeral`) must not move the shared cursor either: before this, the tool results of the first turn after `/clear` advanced it, and the next turn resumed the pre-`/clear` session (forgot the turn in between, remembered what `/clear` dropped).
- **Tool name/arg translation is two-way and asymmetric.** pi→SDK uses `PI_TO_SDK_TOOL_NAME` + `pascalCase` fallback (convert.ts); SDK→pi uses a separate `SDK_TO_PI_TOOL_NAME` map + custom-tool map + `MCP_TOOL_PREFIX` stripping (`mapToolName` in tool-mapping.ts). Built-in tool arg keys also get renamed both ways (`SDK_KEY_RENAMES`): Claude's `file_path`/`old_string`/`new_string` vs omp's `path`/`oldText`/`newText`.
- **Bash gets an injected 120s timeout** (`mapToolArgs` in tool-mapping.ts) when the SDK doesn't send one, matching Claude Code's own default — omp's bash tool has no default timeout, so without this the two disagree.
- **Custom/omp tools are exposed to Claude Code as MCP tools** named `mcp__custom-tools__<name>` (`MCP_SERVER_NAME`/`MCP_TOOL_PREFIX` in skills.ts), built via `buildMcpServers` (mcp-bridge.ts) using the TypeBox→Zod conversion. `TOOL_NAMING_CLARIFICATION` (prompt.ts) exists specifically because Claude Code otherwise gets confused about whether `mcp__custom-tools__read` etc. are "real" tools distinct from its built-ins — it's injected into the system prompt for this reason. It deliberately does *not* enumerate the tool list (the model already sees its real tools in the system prompt; re-listing is redundant double-prompting) and its prefix-mapping example uses a `<name>` placeholder rather than a concrete tool like `edit` — naming a specific tool would assert it exists, the exact phantom claim that confuses a restricted agent (a read-only scout has no edit tool). It makes two claims that hold for every agent type: the `mcp__custom-tools__<name>` IS-your-`<name>`-tool prefix rule, and that any tool absent from the list is intentional policy — so a scout never reads a missing Edit/Bash as harness breakage to route around.
- **The subagent system prompt is forwarded, not dropped.** oh-my-pi's executor composes the subagent identity prompt (ROLE / CONTEXT / COOP / COMPLETION, including the pinned yield schema, from `subagent-system-prompt.md`) as a distinct element of the `systemPrompt` array — inserted second-to-last. `extractSubagentPrompt` (prompt.ts) finds it by its `ROLE\n===` + `COMPLETION\n===` headers and appends it to the Claude Code preset, so the scout's role-lock and yield-shape survive the bridge translation instead of being replaced by the generic preset. Only that one element is forwarded; the rest of the preset is not duplicated.
- **AskClaude tool mode gating** (`MODE_DISALLOWED_TOOLS` in askclaude.ts) blocks write/bash/etc. tools per mode (`full`/`read`/`none`); `ASKCLAUDE_ALWAYS_BLOCKED` unconditionally blocks plan-mode/interactive-only tools (`AskUserQuestion`, `EnterPlanMode`, etc.) since AskClaude runs headless with no way to surface those to the omp user.
- **AGENTS.md forwarding sanitizes omp-specific references** before handing it to Claude as `CLAUDE.md` (`sanitizeAgentsContent` in agents-md.ts): the `.omp` dotdir (`~/.omp`, `.omp/`, or a bare `.omp`) → `.claude`, then the remaining bare word `omp` → `environment`. Order matters — the `.omp` rewrite runs first so its `omp` isn't caught by the bare-word rule and turned into `.environment` (that was a real bug; `test/agents-md.test.ts` pins it). This intentionally diverges from upstream pi-claude-bridge (different tool); a bare `omp` used conceptually in prose still gets rewritten, which is accepted.
- **1M-context eligibility is measured, not derived from the catalog.** `resolveClaudeCodeRuntimeModel` (models.ts) hardcodes which models actually serve 1M context under which plan, because the SDK's real behavior doesn't match models.json's advertised `contextWindow` (e.g. bare Opus 4.7 serves 1M, bare Opus 4.8 doesn't). Don't "reconcile" this function against the catalog — the catalog is the thing that's wrong for this purpose; `test/models.test.ts` pins the measured table.
- **`QueryContext` (`query-state.ts`) isolates per-query mutable state.** The provider's reentrant path (a nested/isolated AskClaude call or plan-mode sub-query mid-stream) constructs a fresh `new QueryContext()` and tracks it in `activeQueryContexts` rather than clobbering the outer stream's in-flight state. The module also exports a `pushContext`/`popContext` stack that swaps the active `ctx()`, but the provider does **not** currently use it (only `test/query-state.test.ts` exercises it) — don't assume `ctx()` is swapped for nested queries.
- **omp sends a `developer` message role alongside `user`.** pi-ai's published `Message` role union omits it, but role checks in `convert.ts`/`prompt.ts`/`provider.ts` (extracting the last user prompt, tool results, streaming trigger conditions) accept `"developer"` too — grep for `"developer"` if similar role-comparison bugs show up elsewhere.
- **oh-my-pi's steered `<system-notice>`/`<system-interrupt>` framework notices get retagged to `<system-reminder>` for Claude.** These are hidden messages oh-my-pi "steers" into the live conversation (xd:// mount deltas, thinking-loop redirects, etc.) that arrive here flattened to plain `user`-role text — oh-my-pi's own tag names carry no special weight in Claude's training, so Claude (correctly) can't structurally distinguish a genuine one from an attacker forging the same text, even with an in-band "this is not a prompt injection" disclaimer. `convertPiMessages` (convert.ts) rewrites both tags to `<system-reminder>`, a convention Claude Code models are actually trained to trust as framework-injected. The tag list is data-driven: `STEERED_NOTICE_TAGS` builds the regex, so when oh-my-pi adds a new steered-notice tag name (they live in oh-my-pi `packages/coding-agent/src/prompts/system/*.md`) it's a one-line add there and `test/convert.test.ts` auto-covers it.

## Known latent issues

Point-in-time audit backlog (2026-07-20) — real but unfixed; not blocking. Verify before relying on any line, code moves.

- **Rate-limit `resetsAt` unit** (stream-processing.ts, `consumeQuery` rate_limit_event): `new Date(resetsAt)` treats the SDK's unix-*seconds* value as ms → renders a 1970 time. Needs `resetsAt < 1e12 ? resetsAt * 1000 : resetsAt`.
- **Non-`success` result subtypes are swallowed.** Provider finalizes an `error_max_turns`/`error_during_execution` result as a normal `stop`; AskClaude returns empty text with `stopReason: "stop"` (current behavior pinned in `test/askclaude.test.ts`). Neither surfaces the error.
- **`diagDump` can throw when `CLAUDE_BRIDGE_DEBUG` is off** (debug.ts): the log dir is only `mkdir`'d under debug, but `diagDump` appends unconditionally (called on the provider empty-prompt path and session-verify failure).
- **Bash timeout unit** (tool-mapping.ts `mapToolArgs`): injects 120 (seconds) when absent, but a model sending Claude-Code-native *ms* (e.g. `120000`) is clamped by omp to 1h.
- **MCP handler↔tool_use pairing is positional** (mcp-bridge.ts `buildMcpServers`): handlers claim `turnToolCallIds[nextHandlerIdx++]`, assuming SDK invokes handlers in stream order; out-of-order parallel calls can mis-pair, and an over-run index registers an unresolvable handler.
- **Reentrant queries share the `SessionStore`** (provider.ts): a nested query with a longer/divergent context takes the rebuild path against the same session file the outer in-flight query uses.
- **Empty user content arrays** (convert.ts): a user message whose blocks all filter to null pushes `content: []` into the session JSONL (the assistant branch guards `length > 0`; the user branch doesn't).
- **AskClaude mode fallback is permissive** (askclaude.ts): `MODE_DISALLOWED_TOOLS[mode] ?? []` → an unrecognized mode blocks nothing; `execute` doesn't re-check `allowFullMode`.
- **typebox→zod drops nested structure** (typebox-to-zod.ts): nested objects → `z.record(z.string(), z.unknown())`, unions → `z.unknown()`, so structured tool params (`task.tasks[]`, `todo.list[]`) reach Claude schema-less.
- **Deferred (steered-during-tool-wait) user messages drop images** (provider.ts): replayed via `extractUserPrompt` (text only) as a plain string prompt.
- **Plan-mode/restricted subagents wipe extension providers (upstream oh-my-pi bug, not fixable bridge-side).** Sessions created with `restrictToolNames: true` (e.g. plan-mode sub-queries, structured-subagent.ts) load zero extensions, but oh-my-pi's `createAgentSession` still runs `syncExtensionSources([])` + `clearSourceRegistrations` on the shared ModelRegistry (sdk.ts ~line 2008) — removing claude-bridge with nothing to re-register it. Symptom: "No API key for provider: claude-bridge" after a plan-mode sub-query, even with the unconditional registration in index.ts. Needs an upstream fix (restricted sessions should skip the source sync since they skip extension loading).
