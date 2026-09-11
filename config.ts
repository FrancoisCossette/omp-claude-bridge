// User-facing extension config. Ported from pi-claude-bridge with oh-my-pi paths.
// Loaded once at extension registration from ~/.omp/agent/claude-bridge.json and
// the project .omp/claude-bridge.json, project overriding global.

import type { SettingSource, Settings } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
  askClaude?: {
    enabled?: boolean;
    name?: string;
    label?: string;
    description?: string;
    defaultMode?: "full" | "read" | "none";
    defaultIsolated?: boolean;
    allowFullMode?: boolean;
    appendSkills?: boolean;
  };
  /** Low-level Claude Agent SDK plumbing. Most users won't need these. */
  provider?: {
    appendSystemPrompt?: boolean;
    settingSources?: SettingSource[];
    /** Extra Claude Code settings for the spawned CLI, layered over the user's
     *  own. E.g. `claudeMdExcludes` skips a CLAUDE.md whose content the bridge
     *  already forwards through AGENTS.md. */
    settings?: Settings;
    strictMcpConfig?: boolean;
    pathToClaudeCodeExecutable?: string;
    plan?: "pro" | "max";
    longContextExtraUsage?: boolean;
  };
}

export function tryParseJson(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`claude-bridge: failed to parse ${path}: ${e}`);
    return {};
  }
}

export function loadConfig(cwd: string, homeDir: string = homedir()): Config {
  const global = tryParseJson(
    join(homeDir, ".omp", "agent", "claude-bridge.json"),
  );
  const project = tryParseJson(join(cwd, ".omp", "claude-bridge.json"));
  return {
    askClaude: { ...global.askClaude, ...project.askClaude },
    provider: { ...global.provider, ...project.provider },
  };
}
