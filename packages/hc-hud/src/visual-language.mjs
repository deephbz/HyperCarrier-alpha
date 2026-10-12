import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isStale } from "./contract.mjs";

// Semantics: reusable without TUI tiers or glyphs.
export { isStale };
export const budgetPercent = (value) => value.used === null ? null : 100 * value.used / value.limit;
export const hasActionState = (value) => Boolean(value.phase) || value.mode === "disarmed";
export function budgetTone(value) {
  const percent = budgetPercent(value);
  return percent >= 100 ? "error" : percent >= (value.threshold ?? 90) ? "warning" : undefined;
}
export const controlTone = (value) => value.mode === "disarmed" ? "error" : value.phase ? "accent" : undefined;
const base = (path) => path.split("/").filter(Boolean).pop() ?? path;
export function aliasName(model, aliases = {}) {
  if (!model) return "no-model";
  const configured = aliases[`${model.provider}/${model.id}`];
  const id = base(model.id).replace(/^claude-/, "").replace(/-(\d+(?:-\d+)*)$/, (_, digits) => digits.replaceAll("-", "."));
  return typeof configured === "string" ? configured : `${model.provider}/${id}`;
}

// TUI: order controls placement; priority controls width shedding.
export const TIERS = Object.freeze(["full", "compact", "minimal"]);
export const SEPARATOR = " · ";
export const GLYPHS = Object.freeze({ cycle: "⟲", absent: "—", stale: "?", unread: "↑", ok: "✓", error: "✗" });
export const THINKING = Object.freeze({ off: "", minimal: "-Mn", low: "-L", medium: "-M", high: "-H", xhigh: "-XH", max: "-XH" });
const sanitizeStatus = (text) => String(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
export const clean = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/ +/g, " ").trim();
export const formatTokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
export const modelAlias = (model, aliases) => clean(`${aliasName(model, aliases)}${THINKING[model?.thinking] ?? ""}`);
function ratioSpans(value, tier, budget) {
  const percent = budgetPercent(value);
  const spans = [{ text: percent === null ? "?" : `${Math.round(percent)}%`, tone: budget ? budgetTone(value) : undefined }];
  if (tier === "minimal") {
    if (budget && hasActionState(value)) spans.push({ text: GLYPHS.cycle, tone: controlTone(value) });
  } else {
    const mode = budget ? value.phase === "handoff" ? "handoff" : value.phase === "compacting" ? "compact" : value.mode === "disarmed" ? "failed" : value.mode === "off" ? "off" : `${value.threshold ?? 90}` : budget === false ? GLYPHS.absent : null;
    spans.push({ text: `/${formatTokens(value.limit)}${mode !== null && tier === "full" ? " " : ""}` });
    if (mode !== null) spans.push({ text: `${GLYPHS.cycle}${mode}`, tone: budget ? controlTone(value) : undefined });
  }
  if (budget && value.held > 0) {
    if (tier === "full") spans.push({ text: " " });
    spans.push({ text: tier === "full" ? `held ${value.held}` : `+${value.held}`, tone: "warning" });
  }
  return spans;
}
const spanText = (spans) => spans.map((span) => span.text).join("");
const ratio = (value, tier, budget) => spanText(ratioSpans(value, tier, budget));
function contextSpans(state, tier) {
  const slot = state.slots.get("context.budget");
  if (slot) return ratioSpans(slot.value, tier, true);
  return state.context ? ratioSpans({ used: state.context.used, limit: state.context.limit }, tier, false)
    .map((span) => ({ ...span, tone: "dim" })) : [];
}
export function genericValue(value, tier) {
  switch (value.kind) {
    case "ratio": return ratio(value, tier);
    case "identity": return tier === "full" ? `${value.team}/${value.role}` : value.role;
    case "label": case "status": return value.text;
    case "count": return `${value.n}${value.unread !== undefined ? `${GLYPHS.unread}${value.unread}` : ""}`;
    default: return "";
  }
}
function rarebit(value, tier) {
  if (tier === "minimal") return null;
  if (value.kind !== "count") return genericValue(value, tier);
  return `rb ${value.n}${GLYPHS.unread}${value.unread ?? 0}${tier === "full" && value.status ? ` ${value.status === "ok" ? GLYPHS.ok : GLYPHS.error}sum` : ""}`;
}
export const SLOTS = Object.freeze([
  { key: "session", line: 0, order: 10, priority: 100, text: (s) => s.session },
  { key: "cwd", line: 0, order: 20, priority: 90, text: (s, t) => t === "full" ? `${s.cwd}${s.branch ? ` (${s.branch})` : ""}` : t === "compact" ? `${base(s.cwd)}${s.branch && s.branch !== base(s.cwd) ? ` (${s.branch})` : ""}` : base(s.cwd) },
  { key: "team.member", line: 0, order: 30, priority: 60, text: (s, t) => {
    const value = s.slots.get("team.member")?.value;
    if (!value || s.multiplexer || t === "minimal") return null;
    return s.session === value.team || t === "compact" ? value.role : `${value.team}/${value.role}`;
  } },
  { key: "model", line: 1, order: 10, priority: 70, text: (s) => modelAlias(s.model, s.aliases) },
  { key: "context.budget", line: 1, order: 20, priority: 100, spans: contextSpans, text: (s, t) => spanText(contextSpans(s, t)) },
  { key: "cost", line: 1, order: 30, priority: 50, text: (s, t) => t === "minimal" ? null : `$${s.cost.toFixed(2)}${t === "full" && s.cacheHit !== undefined ? ` CH${Math.floor(s.cacheHit)}%` : ""}` },
  { key: "rarebit.summary", line: 1, order: 40, priority: 30, text: (s, t) => s.slots.has("rarebit.summary") ? rarebit(s.slots.get("rarebit.summary").value, t) : null },
]);
function fit(parts, width, separator = SEPARATOR) {
  while (parts.length > 1 && visibleWidth(parts.map((p) => p.text).join(separator)) > width) {
    let lowest = parts.length - 1;
    for (let i = parts.length - 2; i >= 0; i--) if (parts[i].priority < parts[lowest].priority) lowest = i;
    parts.splice(lowest, 1);
  }
  return truncateToWidth(parts.map((p) => p.text).join(separator), Math.max(0, width), "…");
}
export function renderFooter(state, width, { tier = "auto", theme, now = Date.now(), noColor = Boolean(process.env.NO_COLOR) } = {}) {
  const s = { slots: new Map(), cost: 0, ...state };
  const color = theme && !noColor;
  const paintSpan = ({ text, tone, bold }) => {
    let painted = color && tone ? theme.fg(tone, text) : text;
    if (color && bold && theme.bold) painted = theme.bold(painted);
    return painted;
  };
  const paint = (key, spans) => {
    const slot = s.slots.get(key);
    if (slot && isStale(slot, now)) return paintSpan({ text: clean(spanText(spans)) + GLYPHS.stale, tone: "dim" });
    if (slot?.value.kind === "status") {
      const tone = { ok: "success", warn: "warning", error: "error" }[slot.value.level];
      return paintSpan({ text: clean(spanText(spans)), tone });
    }
    return spans.map(paintSpan).join("");
  };
  const known = new Set(SLOTS.map((slot) => slot.key));
  const partsFor = (line, t) => {
    const parts = [];
    for (const slot of SLOTS.filter((slot) => slot.line === line).sort((a, b) => a.order - b.order)) {
      const spans = slot.spans ? slot.spans(s, t) : [{ text: clean(slot.text(s, t) ?? ""),
        tone: ["cwd", "cost"].includes(slot.key) ? "dim" : undefined, bold: slot.key === "session" }];
      if (spanText(spans)) parts.push({ text: paint(slot.key, spans), priority: slot.priority });
    }
    if (line === 1) for (const [key, slot] of [...s.slots].sort(([a], [b]) => a.localeCompare(b))) {
      if (!known.has(key)) parts.push({ text: paint(key, [{ text: clean(genericValue(slot.value, t)) }]), priority: 10 });
    }
    return parts;
  };
  const separator = paintSpan({ text: SEPARATOR, tone: "dim" });
  const output = [0, 1].map((line) => {
    let parts;
    // Measure complete candidates before shedding. Lines choose independently.
    for (const candidate of tier === "auto" ? TIERS : [tier]) {
      parts = partsFor(line, candidate);
      if (visibleWidth(parts.map((part) => part.text).join(separator)) <= width) break;
    }
    return fit(parts, width, separator);
  });
  if (s.statuses?.size) output.push(truncateToWidth([...s.statuses].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => sanitizeStatus(text)).join(" "), Math.max(0, width), paintSpan({ text: "...", tone: "dim" })));
  return color ? output : output.map(stripVTControlCharacters);
}
