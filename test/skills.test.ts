import { describe, expect, test } from "bun:test";
import { extractSkillsBlock, rewriteSkillsBlock } from "../skills.js";

const SKILLS_PROMPT = [
  "You are a coding agent.",
  "The following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file when relevant.",
  "<available_skills>",
  "- pdf-tools",
  "</available_skills>",
  "More instructions after.",
].join("\n");

describe("extractSkillsBlock", () => {
  test("extracts from start marker through closing tag", () => {
    const block = extractSkillsBlock(SKILLS_PROMPT)!;
    expect(block.startsWith("The following skills provide")).toBe(true);
    expect(block.endsWith("</available_skills>")).toBe(true);
    expect(block).toContain("- pdf-tools");
    expect(block).not.toContain("More instructions after");
  });

  test("rewrites the read-tool reference to the MCP name", () => {
    expect(extractSkillsBlock(SKILLS_PROMPT)).toContain(
      "Use the read tool (mcp__custom-tools__read) to load a skill's file",
    );
  });

  test("returns undefined when markers are missing or prompt is empty", () => {
    expect(extractSkillsBlock(undefined)).toBeUndefined();
    expect(extractSkillsBlock("no skills here")).toBeUndefined();
    expect(
      extractSkillsBlock(
        "The following skills provide specialized instructions for specific tasks. but never closes",
      ),
    ).toBeUndefined();
  });
});

const OMP_SKILLS_PROMPT = [
  "§ Runtime",
  "# Skills & Rules",
  "Matching skill → MUST read `skill://<name>` first.",
  "<skills>",
  "- impeccable: frontend design",
  "- user-coding-style: personal code conventions",
  "</skills>",
  "",
  "# Next section",
].join("\n");

describe("extractSkillsBlock (omp 18 format)", () => {
  test("forwards the <skills> block with skill:// loading instructions", () => {
    const block = extractSkillsBlock(OMP_SKILLS_PROMPT)!;
    expect(block).toContain("- impeccable: frontend design");
    expect(block).toContain("- user-coding-style: personal code conventions");
    expect(block).toContain("mcp__custom-tools__read");
    expect(block).toContain("`skill://<name>`");
    expect(block.endsWith("</skills>")).toBe(true);
    expect(block).not.toContain("# Next section");
  });

  test("ignores <skills> tags that are not on their own lines", () => {
    expect(
      extractSkillsBlock("Mention <skills>\n- a\n</skills> in prose"),
    ).toBeUndefined();
  });

  test("returns undefined for an empty block", () => {
    expect(extractSkillsBlock("<skills>\n</skills>")).toBeUndefined();
  });
});

describe("rewriteSkillsBlock", () => {
  test("leaves blocks without the read-tool sentence unchanged", () => {
    expect(rewriteSkillsBlock("plain block")).toBe("plain block");
  });
});
