import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { ComponentType } from "react";
import type { PiTrace, TraceRecord } from "./types";

/** A minimal active-branch trace for Trace Viewer behavior tests. */
export function traceRecord(order: number, rarebit: boolean, text: string): TraceRecord {
  return {
    recordId: `record-${order}`,
    sourceEntryId: `entry-${order}`,
    order,
    kind: "message",
    lane: "input",
    label: `Record ${order}`,
    turn: 1,
    step: order,
    timestamp: null,
    text,
    rarebit,
    details: {},
    unavailable: {},
    raw: { order, text },
  };
}

export const traceFixture: PiTrace = {
  availability: "available",
  schemaVersion: "pi-trace/1",
  sessionId: "session-test",
  sourceVersion: "source-1",
  selectorVersion: "selector-1",
  activeLeafId: "leaf-1",
  activeBranchIds: ["leaf-1"],
  records: [
    traceRecord(0, false, "ordinary context"),
    traceRecord(1, true, "# Selected evidence"),
    traceRecord(2, false, "later context"),
  ],
  selection: {
    selectorVersion: "selector-1",
    manifestHash: "hash-1",
    rarebitSourceEntryIds: ["entry-1"],
  },
};

export function installStubEventSource() {
  class StubEventSource {
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

export function renderTraceViewer(Viewer: ComponentType, trace: PiTrace = traceFixture) {
  window.history.replaceState({}, "", "/session/session-test");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(trace), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return render(<Viewer />);
}
