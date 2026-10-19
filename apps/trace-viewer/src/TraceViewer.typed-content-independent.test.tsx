import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceViewer } from "./TraceViewer";
import {
  contentSearchText,
  normalizeTraceQuery,
  recordMatchesNormalizedTraceQuery,
} from "./trajectory-projection";
import type { PiTrace, TraceContentBlock, TraceRecord } from "./types";
import { installStubEventSource, renderTraceViewer } from "./test-fixtures";

beforeEach(() => installStubEventSource());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

const block = <T extends TraceContentBlock>(value: T): T => value;

function traceRecord(
  order: number,
  sourceEntryId: string,
  kind: string,
  lane: "input" | "model" | "tools",
  label: string,
  content: readonly TraceContentBlock[],
): TraceRecord {
  return {
    recordId: `entry:${sourceEntryId}`,
    sourceEntryId,
    order,
    kind,
    lane,
    label,
    turn: 1,
    step: order === 0 ? null : order,
    timestamp: null,
    content,
    rarebit: true,
    details: {},
    unavailable: {},
    raw: {
      type: "message",
      id: sourceEntryId,
      message: { role: kind === "tool_result" ? "toolResult" : "assistant" },
    },
  };
}

const mixedContent: readonly TraceContentBlock[] = [
  block({ kind: "reasoning", sourceBlockIndex: 0, text: "private reasoning marker" }),
  block({ kind: "prose", sourceBlockIndex: 1, text: "Visible prose before the call." }),
  block({
    kind: "tool_call",
    sourceBlockIndex: 2,
    id: "call-1",
    name: "read",
    arguments: { path: "x" },
    toolResultRecordId: "entry:tool-result",
  }),
  block({
    kind: "unsupported",
    sourceBlockIndex: 3,
    nativeType: "image",
    reason: "Pi content block type is not supported by the typed trace contract.",
    raw: { type: "image", data: "opaque-image" },
  }),
  block({ kind: "prose", sourceBlockIndex: 4, text: "Visible prose after the call." }),
];

const typedTrace: PiTrace = {
  availability: "available",
  schemaVersion: "pi-trace/2",
  sessionId: "typed-content-ui",
  sourceVersion: "source-typed-content",
  selectorVersion: "selector-typed-content",
  activeLeafId: "leaf-1",
  activeBranchIds: ["leaf-1"],
  records: [
    traceRecord(0, "user", "input", "input", "User message", [
      block({ kind: "prose", sourceBlockIndex: 0, text: "Owner request" }),
    ]),
    traceRecord(1, "assistant-mixed", "assistant", "model", "Assistant message", mixedContent),
    traceRecord(2, "tool-result", "tool_result", "tools", "Tool result", [
      block({
        kind: "tool_result",
        sourceBlockIndex: 0,
        text: "Tool output marker",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
      }),
    ]),
  ],
  selection: {
    selectorVersion: "selector-typed-content",
    manifestHash: "hash-typed-content",
    rarebitSourceEntryIds: ["user", "assistant-mixed", "tool-result"],
  },
};

describe("TraceViewer typed content boundaries", () => {
  it("renders prose while keeping reasoning, tools, and unsupported blocks collapsed", async () => {
    const view = renderTraceViewer(TraceViewer, typedTrace);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Assistant message/ })).toBeTruthy(),
    );

    fireEvent.click(view.container.querySelector('[data-record-id="entry:assistant-mixed"]')!);
    expect(screen.getByText("Visible prose before the call.").tagName).toBe("P");
    expect(screen.getByText("Visible prose after the call.").tagName).toBe("P");

    for (const label of [
      /Reasoning · source block 1/,
      /Tool call · read · source block 3/,
      /Unsupported content · image · source block 4/,
    ]) {
      const summary = screen.getByText(label);
      expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
    }
  });

  it("keeps raw typed sections ordered and uses prose preformatted text rather than typed JSON", async () => {
    const view = renderTraceViewer(TraceViewer, typedTrace);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Assistant message/ })).toBeTruthy(),
    );
    fireEvent.click(view.container.querySelector('[data-record-id="entry:assistant-mixed"]')!);
    fireEvent.click(screen.getByRole("button", { name: /Raw (text|blocks)/ }));
    for (const label of [
      /Reasoning · source block 1/,
      /Tool call · read · source block 3/,
      /Unsupported content · image · source block 4/,
    ])
      fireEvent.click(screen.getByText(label));
    await waitFor(() =>
      expect(view.container.querySelectorAll("pre.record-content").length).toBeGreaterThan(3),
    );

    const typedContent = view.container.querySelector(".typed-content")?.textContent ?? "";
    const rawBlocks = [...view.container.querySelectorAll("pre.record-content")]
      .map((element) => element.textContent ?? "")
      .join("\\n");
    expect(typedContent).toContain("Reasoning");
    expect(typedContent).toContain("Tool call · read");
    expect(typedContent).toContain("Unsupported content · image");
    expect(rawBlocks).toContain("Visible prose before the call.");
    expect(rawBlocks).toContain("private reasoning marker");
    expect(rawBlocks).toContain('"path": "x"');
    expect(rawBlocks).toContain('"type": "image"');
    expect(rawBlocks).not.toContain('"kind": "prose"');
    expect(rawBlocks.indexOf("private reasoning marker")).toBeLessThan(
      rawBlocks.indexOf("Visible prose before the call."),
    );
    expect(rawBlocks.indexOf("Visible prose before the call.")).toBeLessThan(
      rawBlocks.indexOf('"path": "x"'),
    );
    expect(rawBlocks.indexOf('"path": "x"')).toBeLessThan(rawBlocks.indexOf('"type": "image"'));
    expect(rawBlocks.indexOf('"type": "image"')).toBeLessThan(
      rawBlocks.indexOf("Visible prose after the call."),
    );
    expect(screen.getByText("Visible prose before the call.").tagName).toBe("PRE");
  });

  it("expands typed blocks and follows a unique tool call to its result", async () => {
    const view = renderTraceViewer(TraceViewer, typedTrace);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Assistant message/ })).toBeTruthy(),
    );
    fireEvent.click(view.container.querySelector('[data-record-id="entry:assistant-mixed"]')!);

    fireEvent.click(screen.getByText(/Reasoning · source block 1/));
    expect(screen.getByText("private reasoning marker")).toBeTruthy();

    fireEvent.click(screen.getByText(/Tool call · read · source block 3/));
    expect(screen.getByText(/"path": "x"/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open tool result" }));
    expect(screen.getByRole("heading", { name: "Tool result" })).toBeTruthy();

    fireEvent.click(screen.getByText(/Tool result · read · source block 1/));
    expect(screen.getByText("Tool output marker")).toBeTruthy();
  });

  it("rejects a pi-trace/1 payload with an explicit version error and raw recovery link", async () => {
    const legacyTrace = {
      ...typedTrace,
      schemaVersion: "pi-trace/1",
      records: typedTrace.records.map((record) => ({
        ...record,
        text: "legacy flattened content",
        content: undefined,
      })),
    } as unknown as PiTrace;
    renderTraceViewer(TraceViewer, legacyTrace);

    await waitFor(() => expect(screen.getByRole("heading", { name: /unavailable/i })).toBeTruthy());
    const mainText = screen.getByRole("main").textContent ?? "";
    expect(mainText).toMatch(/pi-trace\/1|pi-trace\/2|schema|version/i);
    expect(screen.getByRole("link", { name: "Download raw JSONL" }).getAttribute("href")).toBe(
      "/raw/session-test",
    );
    expect(screen.queryByText("legacy flattened content")).toBeNull();
  });

  it("defines search over typed semantic content and excludes unsupported raw payload", () => {
    const record = typedTrace.records[1];
    expect(contentSearchText(record.content[0])).toBe("private reasoning marker");
    expect(contentSearchText(record.content[2])).toContain("read");
    expect(contentSearchText(record.content[2])).toContain('"path":"x"');
    expect(contentSearchText(record.content[3])).toContain("image");
    expect(contentSearchText(record.content[3])).not.toContain("opaque-image");
    expect(recordMatchesNormalizedTraceQuery(record, normalizeTraceQuery("reasoning marker"))).toBe(
      true,
    );
    expect(recordMatchesNormalizedTraceQuery(record, normalizeTraceQuery("path"))).toBe(true);
    expect(recordMatchesNormalizedTraceQuery(record, normalizeTraceQuery("opaque-image"))).toBe(
      false,
    );
  });
});
