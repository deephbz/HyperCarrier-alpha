// Transcript projections for Auto Compact messages and the plan tool.
// Model content stays unchanged; these renderers decide only what the human sees.
import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { compactTokens } from "./presentation.mjs";

// Untrusted display text: drop terminal control sequences, keep newlines and tabs.
const clean = (text) => String(text ?? "")
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./g, "")
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
const str = (value) => typeof value === "string" ? clean(value) : "";
const oneOf = (value, allowed) => allowed.includes(value) ? value : undefined;
const labels = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string").map(clean) : [];
// Show at most 20 labels and say how many more exist.
const listOf = (items) => items.length > 20 ? `${items.slice(0, 20).join(", ")} +${items.length - 20} more` : items.join(", ");
const textOf = (content) => clean(typeof content === "string" ? content
  : (content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join("\n"));
const tok = (n) => `${compactTokens(n)} tok`;
const expandKey = () => keyText("app.tools.expand") || "ctrl+o";
// Regular mode leaves the mouse to the terminal, so the key is the primary route.
const hint = (theme, what) => theme.fg("dim", `${expandKey()} ${what} (or click in fullscreen)`);
const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const markdown = (text, theme) => new Markdown(text, 0, 0, getMarkdownTheme(), { color: (t) => theme.fg("customMessageText", t) });

/**
 * Normalize a stored plan view. Historical or malformed details render what is valid
 * and drop the rest; the model never reads these details.
 */
function planOf(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const count = (value) => Number.isFinite(value) ? value : undefined;
  return {
    method: oneOf(raw.method, ["native", "summary", "keepset"]),
    execution: oneOf(raw.execution, ["foreground", "background"]),
    summary: str(raw.summary),
    handoff: str(raw.handoff),
    kept: Array.isArray(raw.kept)
      ? raw.kept.filter((round) => typeof round?.label === "string")
        .map((round) => ({ label: clean(round.label), name: str(round.name), tokens: count(round.tokens), cut: round.cut === true }))
      : [],
    dropped: count(raw.dropped),
    unknown: labels(raw.unknown),
    overBudget: labels(raw.overBudget),
    summaryTokens: count(raw.summaryTokens),
  };
}

/**
 * One custom-message block. Pi rebuilds it with the global expanded flag on Ctrl+O;
 * a left click toggles only this block, as Pi does for tool blocks.
 */
class ToggleBlock {
  constructor(build, expanded, fallback) {
    this.build = build;
    this.expanded = expanded;
    this.fallback = fallback;
  }
  render(width) {
    if (this.cache?.width !== width || this.cache?.expanded !== this.expanded) {
      let lines;
      // Pi catches renderer errors only while it builds the component; render lazily safe.
      try { lines = this.build(this.expanded).render(width); } catch { lines = this.fallback().render(width); }
      this.cache = { width, expanded: this.expanded, lines };
    }
    return this.cache.lines;
  }
  handleMouse(event) {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.expanded = !this.expanded;
    this.cache = undefined;
    return { handled: true };
  }
  invalidate() {
    this.cache = undefined;
  }
}

// Shared shell: label, short body, then detail when expanded or a hint when collapsed.
function messageBlock({ label, lines, detail, what, raw }, { expanded, outputPad }, theme) {
  const shell = () => new Box(outputPad ?? 1, 1, (t) => theme.bg("customMessageBg", t));
  const fallback = () => {
    const box = shell();
    box.addChild(new Text(`${label}\n${raw}`, 0, 0));
    return box;
  };
  return new ToggleBlock((open) => {
    const box = shell();
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(label)), 0, 0));
    for (const line of lines) box.addChild(new Text(theme.fg("customMessageText", line), 0, 0));
    if (detail && open) {
      box.addChild(new Spacer(1));
      for (const component of detail()) box.addChild(component);
    } else if (detail) box.addChild(new Text(hint(theme, what), 0, 0));
    return box;
  }, expanded, fallback);
}

const planLine = (plan) => [
  `${plan.method ?? "plan"}${plan.execution ? ` · ${plan.execution}` : ""}`,
  plan.method === "keepset" ? `kept ${plan.kept.length}/${plural(plan.kept.length + (plan.dropped ?? 0), "tool result")}` : undefined,
  Number.isFinite(plan.summaryTokens) ? `context ${tok(plan.summaryTokens)}` : undefined,
].filter(Boolean).join(" · ");

function planDetail(plan, theme) {
  const parts = [markdown(plan.summary || "(empty summary)", theme)];
  if (plan.handoff) parts.push(new Spacer(1), new Text(theme.fg("customMessageLabel", "Handoff record"), 0, 0), markdown(plan.handoff, theme));
  if (plan.kept.length) {
    parts.push(new Spacer(1), new Text(theme.fg("customMessageLabel", "Kept tool outputs"), 0, 0));
    parts.push(new Text(theme.fg("muted", plan.kept.map((round) =>
      `${round.label} ${round.name} · ${tok(round.tokens)}${round.cut ? " · cut" : ""}`).join("\n")), 0, 0));
  }
  const rejected = [
    plan.overBudget.length ? `over budget: ${listOf(plan.overBudget)}` : undefined,
    plan.unknown.length ? `unknown labels: ${listOf(plan.unknown)}` : undefined,
  ].filter(Boolean);
  if (rejected.length) parts.push(new Text(theme.fg("warning", `Not kept — ${rejected.join("; ")}`), 0, 0));
  return parts;
}

export function renderHandoffMessage(message, options, theme) {
  const text = textOf(message.content);
  const details = message.details && typeof message.details === "object" ? message.details : {};
  const method = oneOf(details.method, ["native", "summary", "keepset"]);
  const lineCount = text.split("\n").length;
  const listed = text.split("\n").filter((line) => /^t\d+ \| /.test(line)).length;
  const planning = text.includes("compaction_plan");
  const preservation = oneOf(details.preservation, ["artifact-handoff", "none"]);
  const preserve = preservation ? preservation !== "none" : !/Artifact preservation is skipped/.test(text);
  const ask = planning
    ? `${preserve ? "Preserve work, then write" : "Write"} a ${method ?? "compaction"} plan${listed ? ` over ${plural(listed, "tool result")}` : ""}.`
    : "Preserve work in durable artifacts, then report ready.";
  return messageBlock({
    label: `Auto Compact · handoff${details.queuedRun ? " · queued" : ""}`,
    lines: [`Asked the agent: ${ask}`],
    detail: () => [new Text(theme.fg("muted", text), 0, 0)],
    what: `to show the full instruction (${lineCount} line${lineCount === 1 ? "" : "s"})`,
    raw: text,
  }, options, theme);
}

export function renderPickupMessage(message, options, theme) {
  const text = textOf(message.content);
  const details = message.details && typeof message.details === "object" ? message.details : {};
  const plan = planOf(details.plan);
  const held = Number(details.heldCount) || 0;
  const label = details.supersedes ? "Auto Compact · pickup after external compaction" : "Auto Compact · pickup";
  const lines = [details.supersedes
    ? "External compaction finished; the agent was told to drop the earlier handoff and continue."
    : held
      ? `Compaction finished; the agent continues with ${plural(held, "message")} you sent meanwhile.`
      : "Compaction finished; the agent was asked to continue."];
  if (plan) lines.push(`Plan: ${planLine(plan)}`);
  const detail = () => [
    ...(plan ? [...planDetail(plan, theme), new Spacer(1)] : []),
    new Text(theme.fg("customMessageLabel", "Sent to the agent"), 0, 0),
    new Text(theme.fg("muted", text), 0, 0),
  ];
  return messageBlock({ label, lines, detail, what: plan ? "to read the plan" : "to show the agent message", raw: text }, options, theme);
}

/** Tool-call view for compaction_plan: a one-line digest that expands to the plan. */
export function renderPlanCall(args, theme, context = {}) {
  const title = theme.fg("toolTitle", theme.bold("Compaction plan"));
  const summary = typeof args?.summary === "string" ? args.summary : "";
  const keep = labels(args?.keep);
  if (context.argsComplete === false && !context.executionStarted)
    return new Text(`${title} ${theme.fg("muted", `writing… ${tok(Math.ceil(summary.length / 4))}`)}`, 0, 0);
  const digest = theme.fg("muted", `summary ${tok(Math.ceil(summary.length / 4))} · keep ${keep.length}`);
  if (!context.expanded) return new Text(`${title} ${digest}  ${hint(theme, "to read")}`, 0, 0);
  const root = new Container();
  root.addChild(new Text(`${title} ${digest}`, 0, 0));
  root.addChild(new Spacer(1));
  root.addChild(markdown(clean(summary) || "(empty summary)", theme));
  if (keep.length) root.addChild(new Text(theme.fg("muted", `Keep: ${listOf(keep)}`), 0, 0));
  return root;
}

export function renderPlanResult(result, _options, theme) {
  const accepted = result?.details?.status === "accepted";
  return new Text(theme.fg(accepted ? "success" : "warning", textOf(result?.content)), 0, 0);
}
