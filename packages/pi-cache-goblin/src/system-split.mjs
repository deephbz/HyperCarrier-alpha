// Find where the session-independent part of pi's system prompt ends.
//
// pi renders sections in a fixed order (pi-coding-agent dist/core/system-prompt.js):
//   preamble, <tools>, <rules>, <docs>, [<addendum>], [<project_context>], [<skills>], <cwd>, custom
// Inside <project_context>, context files come global-first (agent dir, then cwd ancestors from the
// root down). The global layer ends after the last leading context file whose path is in
// `globalPaths`. Everything after it depends on the project, the skills, or the cwd.

// Installed Pi 1.1 renders contextFiles in project_context. Its optional
// appendSystemPrompt becomes addendum before those files. Stop before an unknown
// addendum: its text can depend on the Project, and global files after it cannot
// join a cross-Project prefix without changing prompt order.
const SECTION_START = /(^|\n)<(addendum|project_context|skills|cwd)>\n/;
const INSTRUCTIONS_OPEN = /<project_instructions path="([^"]*)">\n/y;
const INSTRUCTIONS_CLOSE = "\n</project_instructions>";

/**
 * @param {string} text system prompt text
 * @param {{ globalPaths: Iterable<string> }} options
 * @returns {number} offset of the first project-dependent character, or -1 when the text has no
 *   recognizable pi section boundary (a custom or forced prompt).
 */
export function findGlobalBoundary(text, { globalPaths }) {
  if (typeof text !== "string") return -1;
  const match = SECTION_START.exec(text);
  if (!match) return -1;
  const sectionStart = match.index + match[1].length;
  if (match[2] !== "project_context") return sectionStart;

  const globals = new Set(globalPaths);
  // Skip "<project_context>\n" and the fixed heading line.
  const heading = "Project-specific instructions and guidelines:\n\n";
  let cursor = sectionStart + "<project_context>\n".length;
  if (!text.startsWith(heading, cursor)) return sectionStart;
  cursor += heading.length;

  let boundary = sectionStart;
  for (;;) {
    INSTRUCTIONS_OPEN.lastIndex = cursor;
    const open = INSTRUCTIONS_OPEN.exec(text);
    if (!open || !globals.has(open[1])) break;
    const close = text.indexOf(INSTRUCTIONS_CLOSE, INSTRUCTIONS_OPEN.lastIndex);
    if (close < 0) break;
    boundary = close + INSTRUCTIONS_CLOSE.length;
    cursor = boundary;
    if (text.startsWith("\n\n", cursor)) cursor += 2;
    else break;
  }
  return boundary;
}
