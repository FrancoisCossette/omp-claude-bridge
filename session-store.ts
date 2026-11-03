// Shared Claude Code session state + cursor-based sync (Cases 1–4).
// Logic ported from pi-claude-bridge verbatim; wrapped in a class so the
// previously module-global `sharedSession` is constructible/testable.

import type { Context } from "@earendil-works/pi-ai";
import {
  createSession,
  deleteSession,
  repairToolPairing,
  type Session,
} from "cc-session-io";
import { realpathSync, statSync } from "fs";
import { convertPiMessages } from "./convert.js";
import { verifyWrittenSession } from "./session-verify.js";
import { DEBUG, DEBUG_LOG_PATH, debug, diagDump } from "./debug.js";

export interface SessionState {
  sessionId: string;
  cursor: number;
  cwd: string;
  needsRebuild?: boolean;
  forceRotate?: boolean;
  /** OMP provider session id this Claude session belongs to (rotated by /clear). */
  ompSessionId?: string;
}

export interface SyncResult {
  sessionId: string | null;
  preserveSharedSession?: boolean;
}

export type NotifyFn = (message: string, level: "warning" | "error") => void;

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    return `<failed: ${(e as Error).message}>`;
  }
}

function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
  const realCwd = safeRealpath(cwd);
  let fileSize: number | null = null;
  let fileExists = false;
  try {
    const st = statSync(jsonlPath);
    fileExists = true;
    fileSize = st.size;
  } catch {
    /* file may not exist yet */
  }
  debug(`${label}: cwd=${cwd}`);
  if (realCwd !== cwd)
    debug(
      `${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`,
    );
  debug(`${label}: jsonlPath=${jsonlPath}`);
  debug(
    `${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`,
  );
  debug(
    `${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`,
  );
}

function convertAndImportMessages(
  session: Session,
  messages: Context["messages"],
  customToolNameToSdk?: Map<string, string>,
): void {
  const { anthropicMessages, sanitizedIds } = convertPiMessages(
    messages,
    customToolNameToSdk,
  );

  debug(
    `convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`,
  );
  debug(
    `convertAndImportMessages: imported roles:`,
    anthropicMessages
      .map((m, i) => {
        const c = m.content;
        if (typeof c === "string") return `[${i}]${m.role}:text`;
        if (Array.isArray(c))
          return `[${i}]${m.role}:${c.map((b: { type: string }) => b.type).join("+")}`;
        return `[${i}]${m.role}:?`;
      })
      .join(" "),
  );
  if (sanitizedIds.size > 0) {
    debug(
      `convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
      [...sanitizedIds.entries()]
        .map(([orig, clean]) => (orig === clean ? orig : `${orig}→${clean}`))
        .join(", "),
    );
  }
  const repaired = repairToolPairing(anthropicMessages);
  if (repaired.length !== anthropicMessages.length) {
    debug(
      `convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`,
    );
  }
  if (repaired.length) session.importMessages(repaired);
}

export class SessionStore {
  private state: SessionState | null = null;
  private notify?: NotifyFn;

  constructor(notify?: NotifyFn) {
    this.notify = notify;
  }

  get current(): SessionState | null {
    return this.state;
  }

  clear(): void {
    this.state = null;
  }

  /** Force a rebuild on the next sync, keeping the same session id. */
  markRebuild(): void {
    if (this.state) this.state = { ...this.state, needsRebuild: true };
  }

  /** Force a rebuild with a rotated id (post-abort: avoid racing an orphaned writer). */
  markAborted(): void {
    if (this.state)
      this.state = { ...this.state, needsRebuild: true, forceRotate: true };
  }

  /** Move the cursor forward after messages were handled outside sync(). */
  advanceCursor(cursor: number): void {
    if (this.state) this.state.cursor = cursor;
  }

  /** Record the session a completed query ended on. */
  commit(
    sessionId: string,
    cursor: number,
    cwd: string,
    ompSessionId?: string,
  ): void {
    this.state = { sessionId, cursor, cwd, ompSessionId };
  }

  /** Side-channel call: own throwaway session built from the context, shared state untouched. */
  syncEphemeral(
    messages: Context["messages"],
    cwd: string,
    customToolNameToSdk?: Map<string, string>,
    modelId?: string,
  ): SyncResult {
    const priorMessages = messages.slice(0, -1);
    if (priorMessages.length === 0) {
      debug(`Side-channel: clean start, shared session untouched`);
      return { sessionId: null, preserveSharedSession: true };
    }
    const session = createSession({
      projectPath: cwd,
      claudeDir: process.env.CLAUDE_CONFIG_DIR,
      ...(modelId ? { model: modelId } : {}),
    });
    convertAndImportMessages(session, priorMessages, customToolNameToSdk);
    session.save();
    debug(
      `Side-channel: ${priorMessages.length} prior messages → throwaway session ${session.sessionId.slice(0, 8)}, shared session untouched`,
    );
    return { sessionId: session.sessionId, preserveSharedSession: true };
  }

  sync(
    messages: Context["messages"],
    cwd: string,
    customToolNameToSdk?: Map<string, string>,
    modelId?: string,
  ): SyncResult {
    const priorMessages = messages.slice(0, -1);

    // REUSE path
    if (
      this.state &&
      !this.state.needsRebuild &&
      priorMessages.length >= this.state.cursor
    ) {
      const missed = priorMessages.slice(this.state.cursor);
      const trailingAssistantOnly =
        missed.length === 1 &&
        (missed[0] as { role?: string }).role === "assistant";
      if (missed.length === 0 || trailingAssistantOnly) {
        if (trailingAssistantOnly) {
          this.state = {
            ...this.state,
            cursor: priorMessages.length,
            cwd,
          };
        }
        debug(
          `Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${this.state.sessionId.slice(0, 8)}, cursor=${this.state.cursor}`,
        );
        debug(
          `syncResult: path=reuse sessionId=${this.state.sessionId} cursor=${this.state.cursor}`,
        );
        return { sessionId: this.state.sessionId };
      }
    }

    if (
      this.state &&
      !this.state.needsRebuild &&
      priorMessages.length < this.state.cursor
    ) {
      debug(
        `Case 1 synthetic: clean start for shorter context, preserving shared session ${this.state.sessionId.slice(0, 8)}, cursor=${this.state.cursor}`,
      );
      debug(
        `syncResult: path=clean-start preserve-shared sessionId=${this.state.sessionId} cursor=${this.state.cursor}`,
      );
      return { sessionId: null, preserveSharedSession: true };
    }

    // REBUILD path
    if (priorMessages.length === 0) {
      debug(`Case 1: clean start, ${messages.length} total messages`);
      debug(`syncResult: path=clean-start`);
      return { sessionId: null };
    }

    const previousSessionId = this.state?.sessionId;
    const previousCursor = this.state?.cursor ?? 0;
    const preserveId =
      previousSessionId !== undefined && !this.state?.forceRotate;
    if (preserveId) {
      deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
    }
    const session = createSession({
      projectPath: cwd,
      claudeDir: process.env.CLAUDE_CONFIG_DIR,
      ...(preserveId ? { sessionId: previousSessionId } : {}),
      ...(modelId ? { model: modelId } : {}),
    });
    convertAndImportMessages(session, priorMessages, customToolNameToSdk);
    session.save();
    this.verify(
      session.jsonlPath,
      session.sessionId,
      session.messages.length,
      cwd,
    );
    this.state = {
      sessionId: session.sessionId,
      cursor: priorMessages.length,
      cwd,
    };
    if (previousSessionId === undefined) {
      debug(
        `Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`,
      );
    } else if (preserveId) {
      const missedCount = priorMessages.length - previousCursor;
      debug(
        `Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`,
      );
    } else {
      debug(
        `Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`,
      );
    }
    debugSessionPaths(
      `${session.sessionId.slice(0, 8)}`,
      cwd,
      session.jsonlPath,
    );
    debug(
      `syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`,
    );
    return { sessionId: session.sessionId };
  }

  private verify(
    jsonlPath: string,
    expectedSessionId: string,
    expectedRecordCount: number,
    cwd: string,
  ): void {
    const warnings = verifyWrittenSession(
      jsonlPath,
      expectedSessionId,
      expectedRecordCount,
    );
    for (const msg of warnings) {
      debug(`WARNING session verify: ${msg}`);
      this.notify?.(
        `Session file issue: ${msg}\n` +
          `cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
          `Please copy and paste this message into a new issue.` +
          (DEBUG
            ? ` and attach ${DEBUG_LOG_PATH}`
            : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
        "warning",
      );
      diagDump("session_verify_fail", {
        msg,
        jsonlPath,
        cwd,
        realpath: safeRealpath(cwd),
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      });
    }
  }
}
