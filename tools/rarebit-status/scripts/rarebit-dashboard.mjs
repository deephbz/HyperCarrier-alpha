#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentPaneId } from "./lib.mjs";
import {
  loadRarebitPane,
  refreshAllRarebits,
  refreshRarebitPane,
} from "./rarebit.mjs";
import {
  terminalOccurrencePresentation,
  terminalSummaryPresentation,
} from "./visual.mjs";

const paneId = currentPaneId();
let view = "summary";
let data = null;
let status = "Loading exact Session evidence…";
let scroll = 0;
let busy = false;
let closed = false;
let searchMode = false;
let searchDraft = "";
let lastSearch = "";
let currentMatch = -1;

const ansi = {
  clear: "\x1b[2J\x1b[H",
  altOn: "\x1b[?1049h",
  altOff: "\x1b[?1049l",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  reset: "\x1b[0m",
  reverse: "\x1b[7m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function clean(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value, width) {
  const text = clean(value);
  return text.length > width
    ? `${text.slice(0, Math.max(0, width - 1))}…`
    : text;
}

function wrap(value, width, prefix = "") {
  const text = clean(value) || "unavailable";
  const contentWidth = Math.max(12, width - prefix.length);
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (let word of words) {
    if (word.length > contentWidth) {
      if (line) {
        lines.push(`${prefix}${line}`);
        line = "";
      }
      while (word.length > contentWidth) {
        lines.push(`${prefix}${word.slice(0, contentWidth)}`);
        word = word.slice(contentWidth);
      }
    }
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= contentWidth) line += ` ${word}`;
    else {
      lines.push(`${prefix}${line}`);
      line = word;
    }
  }
  if (line) lines.push(`${prefix}${line}`);
  return lines;
}

function timeLabel(value) {
  const date = typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "time ?";
}

function summaryLines(width) {
  if (!data) return [status];
  const summary = data.summary;
  const summaryPresentation = terminalSummaryPresentation(summary, ansi);
  const nativeReadable = data.nativeArtifact?.availability === "available";
  const head = data.materialization?.head;
  const diagnostics = data.materialization?.diagnostics;
  const headReference = head
    ? `offset ${head.receiptOffset ?? "?"} · length ${head.receiptLength ?? "?"} · hash ${String(head.receiptHash ?? "?").slice(0, 12)}`
    : "no current head";
  const headDiagnostics = diagnostics
    ? `torn ${diagnostics.tornTail === true ? "yes" : "no"}${diagnostics.reason ? ` · ${diagnostics.reason}` : ""}`
    : "diagnostics unavailable";
  const lines = [
    `${ansi.bold}Rarebit status${ansi.reset}`,
    `  ${summaryPresentation.text} · ${summary.reason}`,
    `  sync      ${summary.syncState} · applicability ${summary.applicability}`,
    `  as of     ${summary.observedAt ?? "unavailable"}`,
    "",
    `${ansi.bold}Artifacts${ansi.reset}`,
    `  native   ${data.nativeArtifact?.availability ?? "unknown"} · ${data.sessionFile}`,
    `  sidecar  ${data.materialization?.availability ?? "unknown"} · ${data.materialization?.path ?? "unavailable"}`,
    `  head     ${headReference}`,
    `  bounded  ${headDiagnostics}; history is optional via the package reader`,
    "",
    `${ansi.bold}Summary${ansi.reset}`,
  ];
  lines.push(
    ...wrap(
      nativeReadable
        ? (summary.text ?? `No free-form Summary (${summary.reason}).`)
        : `${summary.text ? `${summary.applicability === "request_cut" ? "Lossy sidecar Summary (request cut)" : "Lossy settled sidecar assessment"}: ${summary.text} ` : ""}Raw Rarebit and native trace text are unavailable while the native source is missing or unreadable. Any sidecar projection is historical and current applicability is unverified.`,
      width,
      "  ",
    ),
  );
  if (nativeReadable)
    lines.push(
      "",
      `${ansi.bold}Rarebits${ansi.reset}`,
      `  ${data.selection.occurrences.length} selected messages · ${data.measurement.estimatedRarebitTokens ?? "unknown"} estimated tokens`,
      `  ${Number.isFinite(data.measurement.rarebitRatio) ? (data.measurement.rarebitRatio * 100).toFixed(3) : "unknown"}% of readable active-branch message prose`,
      `  selector ${data.selection.manifest.selectorVersion ?? summary.lineage?.selectorVersion ?? "unknown"}`,
      `  manifest ${summary.lineage?.selectionManifestHash ?? data.selection.manifestHash}`,
    );
  lines.push(
    "",
    `${ansi.bold}Exact Session trace${ansi.reset}`,
    `  Session   ${data.session.id ?? "unavailable"}`,
    `  leaf      ${data.session.activeLeafId ?? "linear Session"}`,
    `  source    ${data.sessionFile}`,
    "",
    `${ansi.bold}Projection lineage${ansi.reset}`,
    `  boundary  ${summary.lineage?.lifecycleBoundary ?? "unknown"}`,
    `  model     ${summary.lineage?.model?.provider ?? "unknown"}/${summary.lineage?.model?.id ?? "unknown"}`,
    `  prompt    ${summary.lineage?.promptVersion ?? "unknown"}`,
    `  impl      ${summary.lineage?.implementationVersion ?? "unknown"}`,
    `  job       ${summary.lineage?.jobId ?? "unknown"}`,
    "",
    `${ansi.dim}${nativeReadable ? "Status is producer-projected; Summary is lossy. Tab 2 opens selected Rarebits linked to this native trace." : "Native source is unavailable, so the timeline is intentionally withheld."}${ansi.reset}`,
  );
  return lines;
}

function timelineLines(width) {
  if (!data) return [status];
  if (data.nativeArtifact?.availability !== "available")
    return [
      "Native Session JSONL is unavailable; raw Rarebit text is intentionally withheld.",
    ];
  const lines = [];
  for (const [index, occurrence] of data.selection.occurrences.entries()) {
    const presentation = terminalOccurrencePresentation(occurrence, ansi);
    lines.push(
      `${presentation.marker} ${ansi.bold}${String(index + 1).padStart(2, "0")}${ansi.reset} ${timeLabel(occurrence.timestamp)} ${ansi.dim}${presentation.label}${ansi.reset}`,
    );
    lines.push(...wrap(occurrence.text, width, "   "));
    lines.push("");
  }
  if (!lines.length) lines.push("No Rarebit occurrences on the active branch.");
  return lines;
}

function activeLines(width) {
  return view === "summary" ? summaryLines(width) : timelineLines(width);
}

function plain(value) {
  return String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function searchMatches(lines, query) {
  if (!query) return [];
  const caseSensitive = /[A-Z]/.test(query);
  const needle = caseSensitive ? query : query.toLowerCase();
  return lines.flatMap((line, index) => {
    const haystack = caseSensitive ? plain(line) : plain(line).toLowerCase();
    return haystack.includes(needle) ? [index] : [];
  });
}

function highlighted(line) {
  return `${ansi.reverse}${line.replaceAll(ansi.reset, `${ansi.reset}${ansi.reverse}`)}${ansi.reset}`;
}

function jumpSearch(direction) {
  if (!lastSearch) {
    status = "No previous search pattern.";
    render();
    return;
  }
  const width = Math.max(50, process.stdout.columns || 100);
  const lines = activeLines(width - 2);
  const matches = searchMatches(lines, lastSearch);
  if (!matches.length) {
    currentMatch = -1;
    status = `Pattern not found: ${lastSearch}`;
    render();
    return;
  }
  const anchor = currentMatch >= 0 ? currentMatch : scroll;
  currentMatch =
    direction > 0
      ? (matches.find((index) => index > anchor) ?? matches[0])
      : (matches.findLast((index) => index < anchor) ?? matches.at(-1));
  scroll = currentMatch;
  const ordinal = matches.indexOf(currentMatch) + 1;
  status = `/${lastSearch} · match ${ordinal}/${matches.length}`;
  render();
}

function render() {
  const width = Math.max(50, process.stdout.columns || 100);
  const height = Math.max(14, process.stdout.rows || 32);
  const bodyHeight = Math.max(4, height - 6);
  const lines = activeLines(width - 2);
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  scroll = Math.max(0, Math.min(scroll, maxScroll));
  const matches = searchMatches(lines, lastSearch);
  if (currentMatch >= 0 && !matches.includes(currentMatch)) currentMatch = -1;
  const shown = lines
    .slice(scroll, scroll + bodyHeight)
    .map((line, index) =>
      scroll + index === currentMatch ? highlighted(line) : line,
    );
  while (shown.length < bodyHeight) shown.push("");
  const viewTabs =
    view === "summary"
      ? `${ansi.bold}[1 Summary]${ansi.reset}  2 Timeline`
      : `1 Summary  ${ansi.bold}[2 Timeline]${ansi.reset}`;
  const range =
    lines.length > bodyHeight
      ? `${scroll + 1}-${Math.min(lines.length, scroll + bodyHeight)}/${lines.length}`
      : `${lines.length} lines`;
  const searchPosition =
    lastSearch && matches.length
      ? ` · /${lastSearch} ${Math.max(0, matches.indexOf(currentMatch) + 1)}/${matches.length}`
      : lastSearch
        ? ` · /${lastSearch} 0/0`
        : "";
  const controls = searchMode
    ? `${ansi.bold}/${searchDraft}█${ansi.reset}  Enter search · Esc cancel · smart-case literal`
    : `${range}${searchPosition} · j/k line · u/d page · g/G · / search · n/N match · Tab view · r/R refresh · a alert · q close`;
  process.stdout.write(
    `${ansi.clear}${ansi.bold}${ansi.magenta}RAREBIT STATUS${ansi.reset} · ${viewTabs}\n` +
      `${ansi.dim}Exact Pi Session evidence · pane ${paneId ?? "unavailable"}${ansi.reset}\n` +
      `${shown.join("\n")}\n` +
      `${ansi.dim}${controls}${ansi.reset}\n` +
      `${ansi.dim}Status: ${clip(status, width - 10)}${ansi.reset}\n`,
  );
}

function close() {
  if (closed) return;
  closed = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${ansi.show}${ansi.altOff}${ansi.reset}`);
}

function deferredNotification() {
  const script = fileURLToPath(
    new URL("./deferred-rarebit-toast.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [script, paneId ?? ""], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  close();
  process.exit(0);
}

async function reload({ report = false, all = false } = {}) {
  if (busy) return;
  busy = true;
  status = all
    ? "Refreshing every exact Pi Session binding…"
    : report
      ? "Refreshing Rarebit selection, Summary, and sidebar…"
      : "Reading Rarebit data…";
  render();
  try {
    let fleet = null;
    if (all) fleet = await refreshAllRarebits("popup:refresh-all");
    data =
      report || all
        ? await refreshRarebitPane(
            paneId,
            all ? "popup:refresh-all-current" : "popup:refresh",
          )
        : await loadRarebitPane(paneId);
    currentMatch = -1;
    const fleetStatus = fleet
      ? ` Refreshed ${fleet.filter((result) => result.ok).length}/${fleet.length} panes.`
      : "";
    status = `Loaded ${data.selection.occurrences.length} Rarebits; RAREBIT ${data.summary.label} (${data.summary.reason}).${fleetStatus}`;
  } catch (error) {
    data = null;
    status = `Error: ${error.message}`;
  } finally {
    busy = false;
    render();
  }
}

function move(delta) {
  scroll += delta;
  render();
}

function handleKey(input) {
  if (searchMode) {
    if (input === "\x1b") {
      searchMode = false;
      searchDraft = "";
      status = "Search cancelled.";
      render();
      return;
    }
    if (input === "\r" || input === "\n") {
      searchMode = false;
      if (searchDraft) {
        lastSearch = searchDraft;
        currentMatch = -1;
        searchDraft = "";
        jumpSearch(1);
      } else {
        status = "Empty search cancelled.";
        render();
      }
      return;
    }
    if (input === "\x7f" || input === "\b") {
      searchDraft = searchDraft.slice(0, -1);
      render();
      return;
    }
    if (input && !/[\u0000-\u001f\u007f]/u.test(input)) {
      searchDraft += input;
      render();
    }
    return;
  }
  if (input === "q" || input === "\x1b" || input === "\x03") {
    close();
    process.exit(0);
  }
  if (input === "/") {
    searchMode = true;
    searchDraft = "";
    render();
    return;
  }
  if (input === "n") return jumpSearch(1);
  if (input === "N") return jumpSearch(-1);
  if (
    input === "\t" ||
    input === "1" ||
    input === "2" ||
    input === "s" ||
    input === "t"
  ) {
    view =
      input === "1" || input === "s"
        ? "summary"
        : input === "2" || input === "t"
          ? "timeline"
          : view === "summary"
            ? "timeline"
            : "summary";
    scroll = 0;
    currentMatch = -1;
    render();
    return;
  }
  if (input === "j" || input === "\x1b[B") return move(1);
  if (input === "k" || input === "\x1b[A") return move(-1);
  const page = Math.max(4, (process.stdout.rows || 32) - 9);
  if (input === "d" || input === "\x1b[6~") return move(page);
  if (input === "u" || input === "\x1b[5~") return move(-page);
  if (input === "g") {
    scroll = 0;
    render();
    return;
  }
  if (input === "G") {
    scroll = Number.MAX_SAFE_INTEGER;
    render();
    return;
  }
  if (input === "r") {
    void reload({ report: true });
    return;
  }
  if (input === "R") {
    void reload({ report: true, all: true });
    return;
  }
  if (input === "a") {
    status = "Closing deck; notification and sound will follow.";
    render();
    setTimeout(deferredNotification, 100);
  }
}

function inputTokens(input) {
  const escapeSequences = ["\x1b[6~", "\x1b[5~", "\x1b[A", "\x1b[B"];
  const tokens = [];
  for (let index = 0; index < input.length;) {
    const sequence = escapeSequences.find((candidate) =>
      input.startsWith(candidate, index),
    );
    if (sequence) {
      tokens.push(sequence);
      index += sequence.length;
    } else {
      const token = String.fromCodePoint(input.codePointAt(index));
      tokens.push(token);
      index += token.length;
    }
  }
  return tokens;
}

process.on("exit", close);
process.on("SIGINT", () => {
  close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  close();
  process.exit(0);
});

process.stdout.write(`${ansi.altOn}${ansi.hide}`);
render();
void reload();

if (!process.stdin.isTTY) {
  status = "stdin is not a terminal; exiting Rarebit Status.";
  render();
  setTimeout(() => process.exit(0), 250);
} else {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (input) => {
    for (const token of inputTokens(input)) {
      if (closed) break;
      handleKey(token);
    }
  });
}
