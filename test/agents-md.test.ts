import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  expandImports,
  extractAgentsAppend,
  findAgentsMdInParents,
  resolveAgentsMdPaths,
  sanitizeAgentsContent,
} from "../agents-md.js";

// A throwaway HOME so the tests never see the developer's real ~/.omp files.
function makeFakeHome(): string {
  return mkdtempSync(join(tmpdir(), "cb-home-"));
}

describe("sanitizeAgentsContent", () => {
  test("rewrites ~/.omp to ~/.claude", () => {
    expect(sanitizeAgentsContent("logs in ~/.omp/agent/foo.log")).toBe(
      "logs in ~/.claude/agent/foo.log",
    );
  });

  test("rewrites relative .omp/ dirs to .claude/", () => {
    expect(sanitizeAgentsContent("see .omp/claude-bridge.json")).toBe(
      "see .claude/claude-bridge.json",
    );
    expect(sanitizeAgentsContent("in '.omp/config' file")).toBe(
      "in '.claude/config' file",
    );
  });

  test("rewrites the bare word omp but not words containing it", () => {
    expect(sanitizeAgentsContent("run omp to start")).toBe(
      "run environment to start",
    );
    expect(sanitizeAgentsContent("prompt and compare")).toBe(
      "prompt and compare",
    );
    // Word boundary protects tokens that merely contain "omp".
    expect(sanitizeAgentsContent("stomp and romp")).toBe("stomp and romp");
  });

  test("rewrites a standalone .omp dotdir to .claude (no trailing slash)", () => {
    // Regression: without a trailing slash or a preceding word char, `.omp`
    // used to fall through to the bare-word rule and become `.environment`.
    expect(sanitizeAgentsContent("the .omp dir")).toBe("the .claude dir");
    expect(sanitizeAgentsContent("see .omp done")).toBe("see .claude done");
  });

  test("rewrites .omp consistently across path shapes and case", () => {
    expect(sanitizeAgentsContent("~/.omp/agent")).toBe("~/.claude/agent");
    expect(sanitizeAgentsContent(".omp/claude-bridge.json")).toBe(
      ".claude/claude-bridge.json",
    );
    expect(sanitizeAgentsContent("x.omp")).toBe("x.claude");
    expect(sanitizeAgentsContent("run OMP now")).toBe("run environment now");
  });
});

describe("findAgentsMdInParents", () => {
  test("finds AGENTS.md walking up from a nested dir", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "# notes");
      const nested = join(root, "a", "b");
      // findAgentsMdInParents only reads; the nested dir need not exist on disk
      expect(findAgentsMdInParents(nested)).toBe(join(root, "AGENTS.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentsMdPaths", () => {
  test("lists the omp user-level file before the project file", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      writeFileSync(join(home, ".omp", "agent", "AGENTS.md"), "global");
      writeFileSync(join(root, "AGENTS.md"), "project");
      expect(resolveAgentsMdPaths(join(root, "src"), home)).toEqual([
        join(home, ".omp", "agent", "AGENTS.md"),
        join(root, "AGENTS.md"),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still honours the legacy ~/.omp/AGENTS.md location", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      mkdirSync(join(home, ".omp"), { recursive: true });
      writeFileSync(join(home, ".omp", "AGENTS.md"), "legacy global");
      expect(resolveAgentsMdPaths(root, home)).toEqual([
        join(home, ".omp", "AGENTS.md"),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns an empty list when nothing exists", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      expect(resolveAgentsMdPaths(root, home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips a project AGENTS.md that the sibling CLAUDE.md imports", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "project");
      writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
      expect(resolveAgentsMdPaths(join(root, "src"), home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a project AGENTS.md that CLAUDE.md only mentions in code", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "project");
      writeFileSync(join(root, "CLAUDE.md"), "Other rules; see `@AGENTS.md`.\n");
      expect(resolveAgentsMdPaths(root, home)).toEqual([join(root, "AGENTS.md")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("expandImports", () => {
  test("inlines a ~/ import from the home directory", () => {
    const home = makeFakeHome();
    try {
      mkdirSync(join(home, "conventions"), { recursive: true });
      writeFileSync(join(home, "conventions", "core.md"), "Code is in English.\n");
      expect(
        expandImports("@~/conventions/core.md\n\n# Policy", join(home, "AGENTS.md"), home),
      ).toBe("Code is in English.\n\n# Policy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resolves relative imports from the importing file's directory", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "a.md"), "A");
      // Trailing sentence punctuation is not part of the path.
      expect(expandImports("Read @docs/a.md.", join(root, "AGENTS.md"))).toBe(
        "Read A.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves code, email-like tokens and missing files untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      writeFileSync(join(root, "a.md"), "A");
      const input = [
        "inline `@a.md` span",
        "```",
        "@a.md",
        "```",
        "mail user@a.md",
        "@missing.md",
      ].join("\n");
      expect(expandImports(input, join(root, "AGENTS.md"))).toBe(input);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("expands nested imports and skips cycles", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      writeFileSync(join(root, "a.md"), "A then @b.md");
      writeFileSync(join(root, "b.md"), "B then @a.md");
      expect(expandImports("@a.md", join(root, "AGENTS.md"))).toBe(
        "A then B then @a.md",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stops after five levels of imports", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(root, `${i}.md`), i < 6 ? `${i} @${i + 1}.md` : "6");
      }
      expect(expandImports("@1.md", join(root, "AGENTS.md"))).toBe(
        "1 2 3 4 5 @6.md",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("extractAgentsAppend", () => {
  test("forwards imported content instead of the @ token", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      writeFileSync(join(home, "core.md"), "Code is in English.");
      writeFileSync(
        join(home, ".omp", "agent", "AGENTS.md"),
        "@~/core.md\n\nDelegate reading.",
      );
      expect(extractAgentsAppend(root, home)).toBe(
        "# CLAUDE.md\n\nCode is in English.\n\nDelegate reading.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wraps sanitized content under a CLAUDE.md heading", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "Config lives in .omp/agent.");
      expect(extractAgentsAppend(root, home)).toBe(
        "# CLAUDE.md\n\nConfig lives in .claude/agent.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns undefined for an empty AGENTS.md", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "   \n  ");
      expect(extractAgentsAppend(root, home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forwards the global file when the project has none", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".omp", "agent", "AGENTS.md"),
        "Delegate reading to subagents.",
      );
      expect(extractAgentsAppend(root, home)).toBe(
        "# CLAUDE.md\n\nDelegate reading to subagents.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("concatenates global and project files, global first", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      writeFileSync(join(home, ".omp", "agent", "AGENTS.md"), "global rules");
      writeFileSync(join(root, "AGENTS.md"), "project rules");
      expect(extractAgentsAppend(join(root, "nested"), home)).toBe(
        "# CLAUDE.md\n\nglobal rules\n\n---\n\nproject rules",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips an empty global file but keeps the project file", () => {
    const home = makeFakeHome();
    const root = mkdtempSync(join(tmpdir(), "cb-agents-"));
    try {
      mkdirSync(join(home, ".omp", "agent"), { recursive: true });
      writeFileSync(join(home, ".omp", "agent", "AGENTS.md"), "\n");
      writeFileSync(join(root, "AGENTS.md"), "project rules");
      expect(extractAgentsAppend(root, home)).toBe(
        "# CLAUDE.md\n\nproject rules",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
