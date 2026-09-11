// AGENTS.md discovery and sanitization for forwarding to Claude Code.
// Ported from pi-claude-bridge with oh-my-pi paths (~/.omp/).

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";

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
      const content = expandImports(
        readFileSync(agentsPath, "utf-8"),
        agentsPath,
        homeDir,
      ).trim();
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

// omp expands `@path` imports in context files before injecting them (see
// oh-my-pi's docs/context-files.md, "@ imports"). Forward the same text, or
// Claude Code only sees the bare token. Same rules as omp: the token starts a
// line or follows a space/tab, code spans and fences are left alone, relative
// paths resolve from the importing file, trailing punctuation is trimmed, five
// hops at most, and cycles or unreadable targets keep the original token.
const MAX_IMPORT_DEPTH = 5;
const IMPORT_TOKEN = /(^|[ \t])@([^\s`]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}"']+$/;
const FENCE = /^\s*(```|~~~)/;
const CODE_SPAN = /(`+).*?\1/g;

export function expandImports(
  content: string,
  filePath: string,
  homeDir: string = homedir(),
  ancestors: ReadonlySet<string> = new Set([resolve(filePath)]),
  depth = 0,
): string {
  let inFence = false;
  return content
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const spans = [...line.matchAll(CODE_SPAN)].map((m) => {
        const start = m.index ?? 0;
        return [start, start + m[0].length] as const;
      });
      return line.replace(
        IMPORT_TOKEN,
        (token: string, lead: string, raw: string, offset: number) => {
          const at = offset + lead.length;
          if (spans.some(([start, end]) => at >= start && at < end)) {
            return token;
          }
          const path = raw.replace(TRAILING_PUNCTUATION, "");
          const imported = readImport(
            path,
            dirname(filePath),
            homeDir,
            ancestors,
            depth,
          );
          return imported === undefined
            ? token
            : `${lead}${imported}${raw.slice(path.length)}`;
        },
      );
    })
    .join("\n");
}

function readImport(
  path: string,
  baseDir: string,
  homeDir: string,
  ancestors: ReadonlySet<string>,
  depth: number,
): string | undefined {
  if (!path || depth >= MAX_IMPORT_DEPTH) return undefined;
  const target =
    path === "~" || path.startsWith("~/")
      ? join(homeDir, path.slice(1))
      : isAbsolute(path)
        ? path
        : resolve(baseDir, path);
  if (ancestors.has(target)) return undefined;
  let content: string;
  try {
    content = readFileSync(target, "utf-8");
  } catch {
    return undefined;
  }
  return expandImports(
    content.trim(),
    target,
    homeDir,
    new Set([...ancestors, target]),
    depth + 1,
  );
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
