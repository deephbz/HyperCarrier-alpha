import { isValidThreshold } from "./threshold.mjs";

const AUTO_COMPACT_SYNTAX =
  "/auto-compact [status|on|off|threshold <percent>|budget <tokens|default>|execution <foreground|background|fg|bg|default>|fg|bg|method <native|summary|keepset|default>|preservation <artifact-handoff|none|default>|run [prompt...]]";
export const AUTO_COMPACT_USAGE = `Usage: ${AUTO_COMPACT_SYNTAX}`;

const VALUES = {
  execution: ["foreground", "background", "fg", "bg", "default"],
  method: ["native", "summary", "keepset", "default"],
  preservation: ["artifact-handoff", "none", "default"],
};
const SUBCOMMANDS = ["status", "on", "off", "threshold", "budget", "run", "execution", "fg", "bg", "method", "preservation"];

export function autoCompactCommandDescription() {
  return AUTO_COMPACT_SYNTAX;
}

// An exact sole match returns null: Pi applies an argument completion on Enter
// instead of submitting, so a fully typed command would need a second Enter.
const complete = (values, token, toValue) => {
  const matches = values.filter((value) => value.startsWith(token));
  if (matches.length === 1 && matches[0] === token) return null;
  return matches.map((value) => ({ value: toValue(value), label: value }));
};

export function getAutoCompactArgumentCompletions(prefix) {
  const normalized = String(prefix ?? "").trimStart();
  if (normalized.includes(" ")) {
    const match = /^(\S+)\s+(\S*)$/.exec(normalized);
    if (!match || !VALUES[match[1]]) return null;
    return complete(VALUES[match[1]], match[2], (value) => `${match[1]} ${value}`);
  }
  return complete(SUBCOMMANDS, normalized, (value) => value);
}

export function parseAutoCompactCommand(input = "") {
  const rawInput = String(input);
  const parts = rawInput.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0] ?? "status";
  const args = parts.slice(1);
  if (!SUBCOMMANDS.includes(subcommand))
    return {
      ok: false,
      error: "unknown_subcommand",
      usage: AUTO_COMPACT_USAGE,
    };

  if (VALUES[subcommand] || subcommand === "fg" || subcommand === "bg") {
    const shortcut = subcommand === "fg" || subcommand === "bg";
    const key = shortcut ? "execution" : subcommand;
    const value = shortcut ? subcommand : args[0];
    if ((shortcut ? args.length !== 0 : args.length !== 1) || !VALUES[key].includes(value))
      return { ok: false, error: "invalid_selection", usage: AUTO_COMPACT_USAGE };
    return { ok: true, subcommand: key, value: value === "fg" ? "foreground" : value === "bg" ? "background" : value };
  }

  if (subcommand === "run") {
    const leading = rawInput.trimStart();
    const remainder = leading.slice("run".length);
    const prompt = /^\s/.test(remainder) ? remainder.slice(1) : "";
    if (!prompt.trim()) return { ok: true, subcommand };
    return { ok: true, subcommand, prompt };
  }

  if (subcommand === "budget") {
    if (args.length === 1 && args[0] === "default")
      return { ok: true, subcommand, budget: "default" };
    const value =
      args.length === 1 && /^\d+k?$/i.test(args[0])
        ? Number(args[0].replace(/k$/i, "")) * (/k$/i.test(args[0]) ? 1000 : 1)
        : undefined;
    if (!Number.isSafeInteger(value) || value <= 0)
      return { ok: false, error: "invalid_budget", usage: AUTO_COMPACT_USAGE };
    return { ok: true, subcommand, budget: value };
  }

  if (subcommand === "threshold") {
    if (args.length !== 1)
      return {
        ok: false,
        error: "invalid_threshold",
        usage: AUTO_COMPACT_USAGE,
      };
    const threshold = Number(args[0]);
    if (!isValidThreshold(threshold))
      return {
        ok: false,
        error: "invalid_threshold",
        usage: AUTO_COMPACT_USAGE,
      };
    return { ok: true, subcommand, threshold };
  }

  if (args.length)
    return {
      ok: false,
      error: "unexpected_arguments",
      usage: AUTO_COMPACT_USAGE,
    };
  return { ok: true, subcommand };
}
