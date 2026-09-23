import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import { join } from "path";
import registerExtension from "../index.js";
import { PROVIDER_ID } from "../convert.js";
import type { BridgeRuntime } from "../runtime.js";

interface FakePi {
  providers: Array<{ id: string; config: Record<string, unknown> }>;
  tools: Array<{ name: string; [k: string]: unknown }>;
  handlers: Record<string, (...args: unknown[]) => unknown>;
  api: unknown;
}

function makeFakePi(): FakePi {
  const providers: FakePi["providers"] = [];
  const tools: FakePi["tools"] = [];
  const handlers: FakePi["handlers"] = {};
  const api = {
    registerProvider: (id: string, config: Record<string, unknown>) =>
      providers.push({ id, config }),
    registerTool: (def: { name: string }) => tools.push(def),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
    },
  };
  return { providers, tools, handlers, api };
}

function load(pi: FakePi): BridgeRuntime {
  // The extension entry casts its own fake-tolerant boundary; cast here too.
  return registerExtension(pi.api as never) as unknown as BridgeRuntime;
}

let home: string;
let cwd: string;
let prevHome: string | undefined;
let prevCwd: string;

// bun snapshots HOME when the process starts, so os.homedir() ignores the
// process.env.HOME set below and loadConfig would read the machine's real
// ~/.omp/agent/claude-bridge.json — one with askClaude disabled is enough to
// fail the registration tests. The mock hands the extension the temp home;
// the env var stays for the code that reads HOME directly.
mock.module("os", () => ({ ...os, homedir: () => home }));

beforeEach(() => {
  home = mkdtempSync(join(os.tmpdir(), "cb-home-"));
  cwd = mkdtempSync(join(os.tmpdir(), "cb-cwd-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  prevCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  process.chdir(prevCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("extension registration", () => {
  test("registers the provider on every load (clear-then-flush safe)", () => {
    const pi1 = makeFakePi();
    load(pi1);
    const pi2 = makeFakePi();
    load(pi2);

    expect(pi1.providers).toHaveLength(1);
    expect(pi2.providers).toHaveLength(1);

    for (const pi of [pi1, pi2]) {
      const entry = pi.providers[0];
      expect(entry.id).toBe(PROVIDER_ID);
      expect(entry.config.api).toBe("claude-bridge");
      expect(typeof entry.config.streamSimple).toBe("function");
      expect(Array.isArray(entry.config.models)).toBe(true);
      expect((entry.config.models as unknown[]).length).toBeGreaterThan(0);
    }
  });

  test("wires the session lifecycle handlers", () => {
    const pi = makeFakePi();
    load(pi);
    expect(typeof pi.handlers.session_start).toBe("function");
    expect(typeof pi.handlers.session_shutdown).toBe("function");
    expect(typeof pi.handlers.session_compact).toBe("function");
    expect(typeof pi.handlers.session_tree).toBe("function");
  });

  test("session_start caches the system prompt, sets ui, clears the store", () => {
    const pi = makeFakePi();
    const runtime = load(pi);
    const ui = { notify: () => {} } as unknown as BridgeRuntime["ui"];
    const ctx = {
      ui,
      getSystemPrompt: () => ["part one", "part two"],
    };
    pi.handlers.session_start({}, ctx);

    expect(runtime.ui).toBe(ui);
    expect(runtime.cachedSystemPrompt).toEqual(["part one", "part two"]);
    expect(runtime.sessions.current).toBeNull();
  });

  test("session_compact / session_tree mark the active session for rebuild", () => {
    const pi = makeFakePi();
    const runtime = load(pi);
    runtime.sessions.commit("sess-1234", 3, cwd);
    expect(runtime.sessions.current?.needsRebuild).toBeFalsy();

    pi.handlers.session_compact({});
    expect(runtime.sessions.current?.needsRebuild).toBe(true);

    runtime.sessions.commit("sess-1234", 3, cwd);
    pi.handlers.session_tree({});
    expect(runtime.sessions.current?.needsRebuild).toBe(true);
  });

  test("registers the AskClaude tool by default", () => {
    const pi = makeFakePi();
    load(pi);
    expect(pi.tools.map((t) => t.name)).toContain("AskClaude");
  });

  test("askClaude.enabled: false skips tool registration", () => {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(
      join(cwd, ".omp", "claude-bridge.json"),
      JSON.stringify({ askClaude: { enabled: false } }),
    );
    const pi = makeFakePi();
    load(pi);
    expect(pi.tools).toHaveLength(0);
    expect(pi.providers).toHaveLength(1);
  });

  test("askClaude.name overrides the registered tool name", () => {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(
      join(cwd, ".omp", "claude-bridge.json"),
      JSON.stringify({ askClaude: { name: "ConsultClaude" } }),
    );
    const pi = makeFakePi();
    load(pi);
    expect(pi.tools.map((t) => t.name)).toContain("ConsultClaude");
  });
});
