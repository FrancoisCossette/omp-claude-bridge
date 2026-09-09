// AGENTS.md discovery and sanitization for forwarding to Claude Code.
// Ported from pi-claude-bridge with oh-my-pi paths (~/.omp/).

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

// omp's user-level context file is ~/.omp/agent/AGENTS.md (see oh-my-pi's
// docs/context-files.md). ~/.omp/AGENTS.md is kept for backwards compatibility
// with earlier versions of this extension.
export function globalAgentsMdPaths(homeDir: string = homedir()): string[] {
  return [
    join(homeDir, ".omp", "agent", "AGENTS.md"),
    join(homeDir, ".omp", "AGENTS.md"),
  ];
}

/** Every AGENTS.md that should reach Claude Code, global first, then the
 *  nearest project file. omp itself layers user-level and project-level
 *  context the same way, so a project AGENTS.md must not shadow the global one. */
export function resolveAgentsMdPaths(
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
): string[] {
  const paths = globalAgentsMdPaths(homeDir).filter((p) => existsSync(p));
  const fromCwd = findAgentsMdInParents(cwd);
  if (fromCwd && !paths.includes(fromCwd)) paths.push(fromCwd);
  return paths;
}

/** @deprecated Use resolveAgentsMdPaths; kept for callers that want one path. */
export function resolveAgentsMdPath(
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
): string | undefined {
  const fromCwd = findAgentsMdInParents(cwd);
  if (fromCwd) return fromCwd;
  return globalAgentsMdPaths(homeDir).find((p) => existsSync(p));
}

export function findAgentsMdInParents(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function extractAgentsAppend(
  cwd: string = process.cwd(),
  homeDir: string = homedir(),
): string | undefined {
  const parts: string[] = [];
  for (const agentsPath of resolveAgentsMdPaths(cwd, homeDir)) {
    try {
      const content = readFileSync(agentsPath, "utf-8").trim();
      if (!content) continue;
      const sanitized = sanitizeAgentsContent(content);
      if (sanitized.length > 0) parts.push(sanitized);
    } catch {
      // Unreadable file: skip it rather than dropping the others.
    }
  }
  if (parts.length === 0) return undefined;
  return `# CLAUDE.md\n\n${parts.join("\n\n---\n\n")}`;
}

export function sanitizeAgentsContent(content: string): string {
  // Order matters: rewrite the `.omp` dotdir (paths and bare references) to
  // `.claude` first, so its `omp` isn't caught by the bare-word rule below and
  // turned into `.environment`. `\.omp\b` covers `~/.omp`, `.omp/`, and a
  // standalone `.omp` alike; `\b` keeps it from touching tokens like `foo.omplex`.
  return content
    .replace(/\.omp\b/gi, ".claude")
    .replace(/\bomp\b/gi, "environment");
}
