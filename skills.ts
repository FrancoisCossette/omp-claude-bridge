// Skills block extraction + MCP naming constants.
// Ported from pi-claude-bridge verbatim.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Extract the skills listing from the harness's system prompt for forwarding to
// Claude Code. pi prompts use an `<available_skills>` block; omp 18 lists skills
// in a `<skills>` block whose entries are loaded through `skill://<name>` URLs.
export function extractSkillsBlock(systemPrompt?: string): string | undefined {
  if (!systemPrompt) return undefined;
  return (
    extractPiSkillsBlock(systemPrompt) ?? extractOmpSkillsBlock(systemPrompt)
  );
}

// The block must sit on its own lines, so a `<skills>` mentioned in prose or in
// a context file does not match. An empty block has no entries to forward.
const OMP_SKILLS_BLOCK = /^<skills>\n[\s\S]*?\n<\/skills>$/m;

function extractOmpSkillsBlock(systemPrompt: string): string | undefined {
  const match = systemPrompt.match(OMP_SKILLS_BLOCK);
  if (!match) return undefined;
  return [
    "The following skills provide specialized instructions for specific tasks.",
    `When a task matches one, load it before proceeding: call ${MCP_TOOL_PREFIX}read with the path \`skill://<name>\`.`,
    match[0],
  ].join("\n");
}

function extractPiSkillsBlock(systemPrompt: string): string | undefined {
  const startMarker =
    "The following skills provide specialized instructions for specific tasks.";
  const endMarker = "</available_skills>";
  const start = systemPrompt.indexOf(startMarker);
  if (start === -1) return undefined;
  const end = systemPrompt.indexOf(endMarker, start);
  if (end === -1) return undefined;
  return rewriteSkillsBlock(
    systemPrompt.slice(start, end + endMarker.length).trim(),
  );
}

export function rewriteSkillsBlock(skillsBlock: string): string {
  return skillsBlock.replace(
    "Use the read tool to load a skill's file",
    `Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
  );
}
