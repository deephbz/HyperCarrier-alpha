export const AUTO_COMPACT_USAGE =
  "Usage: /auto-compact [status|on|off|threshold <percent>|run]";

const SUBCOMMANDS = ["status", "on", "off", "threshold", "run"];

export function autoCompactCommandDescription() {
  return "/auto-compact [status|on|off|threshold <percent>|run]";
}

export function getAutoCompactArgumentCompletions(prefix) {
  const normalized = String(prefix ?? "").trimStart();
  if (normalized.includes(" ")) return null;
  return SUBCOMMANDS.filter((value) => value.startsWith(normalized)).map(
    (value) => ({ value, label: value }),
  );
}

export function parseAutoCompactCommand(input = "") {
  const parts = String(input).trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0] ?? "status";
  const args = parts.slice(1);
  if (!SUBCOMMANDS.includes(subcommand))
    return {
      ok: false,
      error: "unknown_subcommand",
      usage: AUTO_COMPACT_USAGE,
    };

  if (subcommand === "threshold") {
    if (args.length !== 1)
      return {
        ok: false,
        error: "invalid_threshold",
        usage: AUTO_COMPACT_USAGE,
      };
    const threshold = Number(args[0]);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 95)
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
