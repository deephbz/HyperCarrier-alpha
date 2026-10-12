import { isValidThreshold } from "./threshold.mjs";

const AUTO_COMPACT_SYNTAX =
  "/auto-compact [status|on|off|threshold <percent>|budget <tokens|default>|run [prompt...]]";
export const AUTO_COMPACT_USAGE = `Usage: ${AUTO_COMPACT_SYNTAX}`;

const SUBCOMMANDS = ["status", "on", "off", "threshold", "budget", "run"];

export function autoCompactCommandDescription() {
  return AUTO_COMPACT_SYNTAX;
}

export function getAutoCompactArgumentCompletions(prefix) {
  const normalized = String(prefix ?? "").trimStart();
  if (normalized.includes(" ")) return null;
  return SUBCOMMANDS.filter((value) => value.startsWith(normalized)).map(
    (value) => ({ value, label: value }),
  );
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
