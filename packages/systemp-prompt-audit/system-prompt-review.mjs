import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const SYSTEM_PROMPT_REVIEW_PROJECTION_VERSION = 2;
export const MAX_SYSTEM_PROMPT_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Validate the exported evidence and its prompt-and-tools content hash. */
export function validateSystemPromptSnapshot(snapshot) {
  assert(isRecord(snapshot), "System-prompt snapshot must be a JSON object.");
  assert(snapshot.schemaVersion === 1, "Unsupported system-prompt snapshot schemaVersion.");
  assert(typeof snapshot.capturedAt === "string", "Snapshot capturedAt must be a string.");
  assert(typeof snapshot.cwd === "string", "Snapshot cwd must be a string.");
  assert(typeof snapshot.systemPrompt === "string", "Snapshot systemPrompt must be a string.");
  assert(Array.isArray(snapshot.activeTools), "Snapshot activeTools must be an array.");
  assert(isRecord(snapshot.integrity), "Snapshot integrity must be an object.");
  assert(
    typeof snapshot.integrity.contentSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(snapshot.integrity.contentSha256),
    "Snapshot integrity.contentSha256 must be a lowercase SHA-256.",
  );

  const names = new Set();
  for (const tool of snapshot.activeTools) {
    assert(isRecord(tool), "Each active tool must be an object.");
    assert(typeof tool.name === "string" && tool.name.length > 0, "Each active tool needs a name.");
    assert(!names.has(tool.name), `Duplicate active tool '${tool.name}'.`);
    names.add(tool.name);
  }

  const expected = sha256(
    JSON.stringify({
      systemPrompt: snapshot.systemPrompt,
      activeTools: snapshot.activeTools,
    }),
  );
  assert(
    expected === snapshot.integrity.contentSha256,
    `Snapshot content SHA-256 mismatch: expected ${snapshot.integrity.contentSha256}, computed ${expected}.`,
  );
  return snapshot;
}

function json(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function markdownFence(value, language = "") {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function markdownAnnotation(scope) {
  return [
    `### Reviewer annotation: ${scope}`,
    "",
    "<!-- Add feedback here. Keep the JSON snapshot and fenced source unchanged. -->",
    "",
    "- Exact lines or field:",
    "- Feedback:",
    "- Proposed change:",
    "- How to verify:",
  ].join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function promptLineClass(line) {
  const trimmed = line.trim();
  if (!trimmed) return "blank";
  if (/^<\/?[a-zA-Z][^>]*>$/.test(trimmed)) return "tag";
  if (/^#{1,6}\s/.test(trimmed)) return "heading";
  if (/^(?:[-*]|\d+\.)\s/.test(trimmed)) return "list";
  return "text";
}

function characterCount(value) {
  return [...value].length;
}

function estimatedTokens(characters) {
  return Math.ceil(characters / 4);
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function promptLinesHtml(prompt) {
  let cumulativeCharacters = 0;
  return prompt.split("\n").map((line, index) => {
    if (index > 0) cumulativeCharacters += 1;
    cumulativeCharacters += characterCount(line);
    const cumulativeTokens = estimatedTokens(cumulativeCharacters);
    const content = line.length ? escapeHtml(line) : "&nbsp;";
    return `<span class="prompt-line ${promptLineClass(line)}"><span class="line-number" title="Line ${index + 1}">${index + 1}</span><span class="token-count" data-cumulative-chars="${cumulativeCharacters}" data-estimated-tokens="${cumulativeTokens}" title="Approximately ${formatInteger(cumulativeTokens)} cumulative tokens through this line (${formatInteger(cumulativeCharacters)} Unicode characters ÷ 4)">≈${formatInteger(cumulativeTokens)}t</span><span class="line-text">${content}</span></span>`;
  }).join("");
}

function toolAnchor(tool, index) {
  const slug = tool.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  return `tool-${index + 1}-${slug || "unnamed"}`;
}

function renderToolMarkdown(tool, index) {
  const sections = [
    `## ${index + 1}. \`${tool.name}\``,
    "",
    tool.description === undefined ? "_No description supplied._" : escapeHtml(tool.description),
    "",
    "### Parameters",
    "",
    markdownFence(json(tool.parameters), "json"),
  ];
  if (tool.promptGuidelines?.length) {
    sections.push(
      "",
      "### Prompt guidelines",
      "",
      ...tool.promptGuidelines.map((guideline) => `- ${escapeHtml(guideline)}`),
    );
  }
  sections.push(
    "",
    "### Source",
    "",
    markdownFence(json(tool.sourceInfo), "json"),
    "",
    markdownAnnotation(`tool ${tool.name}`),
  );
  return sections.join("\n");
}

function renderToolHtml(tool, index) {
  const guidelines = tool.promptGuidelines?.length
    ? `<section><h4>Prompt guidelines</h4><ul>${tool.promptGuidelines.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`
    : "";
  return `
<section class="tool-card" id="${toolAnchor(tool, index)}">
  <div class="tool-title"><span class="tool-number">${index + 1}</span><h3>${escapeHtml(tool.name)}</h3></div>
  <p class="description">${escapeHtml(tool.description ?? "No description supplied.")}</p>
  <div class="tool-grid">
    <section><h4>Parameters</h4><pre class="json"><code>${escapeHtml(json(tool.parameters))}</code></pre></section>
    <section><h4>Source</h4><pre class="json"><code>${escapeHtml(json(tool.sourceInfo))}</code></pre></section>
  </div>
  ${guidelines}
</section>`;
}

/** Render an editable review document without changing the snapshot evidence. */
export function renderSystemPromptReviewMarkdown(snapshot, sourcePath) {
  validateSystemPromptSnapshot(snapshot);
  const source = sourcePath || "system-prompt snapshot JSON";
  const toolSections = snapshot.activeTools.map(renderToolMarkdown).join("\n\n");
  return `# System prompt review\n\n> Deterministic review projection. The JSON snapshot remains authoritative evidence.\n\n- Snapshot: \`${source}\`\n- Captured: \`${snapshot.capturedAt}\`\n- Working directory: \`${snapshot.cwd}\`\n- Snapshot schema: \`${snapshot.schemaVersion}\`\n- Review projection: \`${SYSTEM_PROMPT_REVIEW_PROJECTION_VERSION}\`\n- Content SHA-256: \`${snapshot.integrity.contentSha256}\`\n- Active tools: \`${snapshot.activeTools.length}\`\n- Prompt estimate: \`≈${formatInteger(estimatedTokens(characterCount(snapshot.systemPrompt)))} tokens\` (Unicode characters ÷ 4)\n\nAdd comments in reviewer-annotation sections and cite the HTML line numbers. Keep the fenced source and JSON evidence unchanged.\n\n# Exact effective system prompt\n\n<!-- BEGIN EXACT SYSTEM PROMPT -->\n\n${markdownFence(snapshot.systemPrompt, "text")}\n\n<!-- END EXACT SYSTEM PROMPT -->\n\n${markdownAnnotation("system prompt")}\n\n# Active tool definitions\n\n${toolSections}\n\n# Snapshot provenance\n\n${markdownFence(json(snapshot.provenance), "json")}\n`;
}

const REVIEW_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f5f7fb;
  --surface: #ffffff;
  --surface-2: #eef2f8;
  --text: #172033;
  --muted: #647089;
  --line: #d8dfeb;
  --accent: #4a5bdc;
  --accent-soft: #e8ebff;
  --tag: #8a3ffc;
  --heading: #0d7680;
  --list: #a04b00;
  --shadow: 0 12px 34px rgba(31, 42, 68, 0.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1220;
    --surface: #151c2c;
    --surface-2: #1c2538;
    --text: #e8ecf6;
    --muted: #a8b2c8;
    --line: #303b53;
    --accent: #9aa7ff;
    --accent-soft: #252e55;
    --tag: #cf9cff;
    --heading: #72d6dc;
    --list: #ffc078;
    --shadow: 0 16px 40px rgba(0, 0, 0, 0.3);
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
.page-header { padding: 38px clamp(24px, 5vw, 72px); color: white; background: linear-gradient(125deg, #3544bb, #6d44c5 58%, #9a4c91); }
.page-header h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 46px); letter-spacing: -0.035em; }
.page-header p { margin: 0; max-width: 880px; color: #eef0ff; }
.layout { display: grid; grid-template-columns: minmax(220px, 290px) minmax(0, 1fr); gap: 28px; max-width: 1600px; margin: 0 auto; padding: 28px; }
nav { position: sticky; top: 20px; align-self: start; max-height: calc(100vh - 40px); overflow: auto; padding: 18px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow); }
nav h2 { margin: 0 0 10px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
nav ol { margin: 0; padding-left: 22px; }
nav li { margin: 6px 0; }
main { min-width: 0; }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 28px; }
.meta { min-width: 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
.meta span { display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .07em; }
.meta code { display: block; overflow-wrap: anywhere; color: var(--text); }
.panel, .tool-card { margin-bottom: 24px; padding: clamp(18px, 3vw, 30px); border: 1px solid var(--line); border-radius: 18px; background: var(--surface); box-shadow: var(--shadow); }
h2 { margin-top: 0; font-size: 25px; letter-spacing: -.02em; }
h3, h4 { letter-spacing: -.01em; }
.prompt-key { display: flex; justify-content: flex-end; margin: -4px 0 8px; color: var(--muted); font-size: 12px; }
.prompt { margin: 0; overflow: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-2); font-size: 12.5px; line-height: 1.55; }
.prompt-line { display: grid; grid-template-columns: 58px 82px minmax(max-content, 1fr); min-height: 1.55em; }
.prompt-line:hover { background: var(--accent-soft); }
.line-number, .token-count { position: sticky; z-index: 1; color: var(--muted); background: color-mix(in srgb, var(--surface-2) 92%, transparent); text-align: right; user-select: none; }
.line-number { left: 0; padding-right: 13px; }
.token-count { left: 58px; padding-right: 12px; color: var(--accent); }
.line-text { padding-left: 14px; padding-right: 18px; white-space: pre; }
.prompt-line.tag .line-text { color: var(--tag); font-weight: 600; }
.prompt-line.heading .line-text { color: var(--heading); font-weight: 700; }
.prompt-line.list .line-text { color: var(--list); }
.tool-title { display: flex; align-items: center; gap: 12px; }
.tool-title h3 { margin: 0; font-size: 22px; }
.tool-number { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 50%; color: var(--accent); background: var(--accent-soft); font-weight: 800; }
.description { color: var(--muted); }
.tool-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 16px; }
.tool-grid section { min-width: 0; }
.json { max-height: 520px; margin: 0; overflow: auto; padding: 15px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-2); font-size: 12px; }
footer { padding: 24px; color: var(--muted); text-align: center; }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; padding: 16px; }
  nav { position: static; max-height: none; }
  .page-header { padding: 28px 20px; }
}
@media print {
  :root { color-scheme: light; }
  body { background: white; }
  nav { display: none; }
  .layout { display: block; max-width: none; padding: 0; }
  .panel, .tool-card { break-inside: avoid; box-shadow: none; }
  .prompt { max-height: none; }
}
`;

/** Render a self-contained, script-free HTML projection for human review. */
export function renderSystemPromptReviewHtml(snapshot, sourcePath) {
  validateSystemPromptSnapshot(snapshot);
  const source = sourcePath || "system-prompt snapshot JSON";
  const toolNavigation = snapshot.activeTools.map((tool, index) =>
    `<li><a href="#${toolAnchor(tool, index)}">${escapeHtml(tool.name)}</a></li>`,
  ).join("");
  const tools = snapshot.activeTools.map(renderToolHtml).join("\n");
  const promptCharacters = characterCount(snapshot.systemPrompt);
  const promptTokenEstimate = estimatedTokens(promptCharacters);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>System prompt review</title>
<style>${REVIEW_CSS}</style>
</head>
<body data-source-sha256="${snapshot.integrity.contentSha256}">
<header class="page-header"><h1>System prompt review</h1><p>Deterministic human projection of immutable Pi prompt evidence. Use the companion Markdown for annotations.</p></header>
<div class="layout">
<nav aria-label="Review contents">
  <h2>Contents</h2>
  <ol><li><a href="#system-prompt">System prompt</a></li>${toolNavigation}</ol>
</nav>
<main>
<section class="meta-grid" aria-label="Snapshot metadata">
  <div class="meta"><span>Snapshot</span><code>${escapeHtml(source)}</code></div>
  <div class="meta"><span>Captured</span><code>${escapeHtml(snapshot.capturedAt)}</code></div>
  <div class="meta"><span>Working directory</span><code>${escapeHtml(snapshot.cwd)}</code></div>
  <div class="meta"><span>Content SHA-256</span><code>${snapshot.integrity.contentSha256}</code></div>
  <div class="meta"><span>Active tools</span><code>${snapshot.activeTools.length}</code></div>
  <div class="meta"><span>Prompt estimate</span><code>≈${formatInteger(promptTokenEstimate)} tokens</code></div>
  <div class="meta"><span>Projection version</span><code>${SYSTEM_PROMPT_REVIEW_PROJECTION_VERSION}</code></div>
</section>
<section class="panel" id="system-prompt">
  <h2>Exact effective system prompt</h2>
  <div class="prompt-key">Line · cumulative ≈tokens (Unicode characters ÷ 4)</div>
  <pre class="prompt" aria-label="Line-numbered system prompt with cumulative token estimates"><code>${promptLinesHtml(snapshot.systemPrompt)}</code></pre>
</section>
<h2 id="active-tools">Active tool definitions</h2>
${tools}
<section class="panel" id="provenance"><h2>Snapshot provenance</h2><pre class="json"><code>${escapeHtml(json(snapshot.provenance))}</code></pre></section>
</main>
</div>
<footer>Source content SHA-256: <code>${snapshot.integrity.contentSha256}</code></footer>
</body>
</html>
`;
}

function resolveInside(cwd, requestedPath, requiredExtension, label) {
  assert(typeof requestedPath === "string" && requestedPath.length > 0, `${label} is required.`);
  const root = path.resolve(cwd);
  const output = path.resolve(root, requestedPath);
  const relative = path.relative(root, output);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must resolve inside the current working directory.`);
  }
  if (path.extname(output).toLowerCase() !== requiredExtension) {
    throw new Error(`${label} must end in ${requiredExtension}.`);
  }
  return output;
}

function defaultReviewPath(snapshotPath) {
  return snapshotPath.slice(0, -path.extname(snapshotPath).length) + ".review.md";
}

async function writeReviewPair(markdownPath, markdown, htmlPath, html) {
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  let markdownWritten = false;
  try {
    await fs.writeFile(markdownPath, markdown, { encoding: "utf8", flag: "wx" });
    markdownWritten = true;
    await fs.writeFile(htmlPath, html, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (markdownWritten) await fs.rm(markdownPath, { force: true });
    throw error;
  }
}

/** Read verified JSON evidence and write one immutable Markdown/HTML review pair. */
export async function writeSystemPromptReviewProjection(input, options = {}) {
  const snapshotPath = resolveInside(input.cwd, input.snapshotPath, ".json", "snapshot_path");
  const reviewPath = resolveInside(
    input.cwd,
    options.reviewPath || defaultReviewPath(snapshotPath),
    ".md",
    "review_path",
  );
  const htmlPath = reviewPath.slice(0, -3) + ".html";
  const stat = await fs.stat(snapshotPath);
  assert(stat.isFile(), "snapshot_path must name a regular file.");
  assert(stat.size <= MAX_SYSTEM_PROMPT_SNAPSHOT_BYTES, "snapshot_path exceeds 16 MiB.");

  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  } catch (error) {
    throw new Error(`snapshot_path is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateSystemPromptSnapshot(snapshot);

  const sourceLabel = (path.relative(path.resolve(input.cwd), snapshotPath) || path.basename(snapshotPath))
    .split(path.sep).join("/");
  const markdown = renderSystemPromptReviewMarkdown(snapshot, sourceLabel);
  const html = renderSystemPromptReviewHtml(snapshot, sourceLabel);
  await writeReviewPair(reviewPath, markdown, htmlPath, html);
  return {
    snapshot,
    snapshotPath,
    reviewPath,
    htmlPath,
    markdownSha256: sha256(markdown),
    htmlSha256: sha256(html),
  };
}
