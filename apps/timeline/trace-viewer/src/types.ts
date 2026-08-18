export type TraceLane = "input" | "model" | "tools";

export interface TraceRecord {
  readonly recordId: string;
  readonly sourceEntryId: string | null;
  readonly order: number;
  readonly kind: string;
  readonly lane: TraceLane;
  readonly label: string;
  readonly turn: number | null;
  readonly step: number | null;
  readonly timestamp: string | number | null;
  readonly text: string;
  readonly rarebit: boolean;
  readonly details: {
    readonly stopReason?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly isError?: boolean;
    readonly toolCalls?: readonly { id: string; name: string; arguments: unknown }[];
    readonly usage?: Record<string, unknown>;
  };
  readonly toolCallRecordId?: string | null;
  readonly unavailable: Record<string, string>;
  readonly raw: unknown;
}

export interface PiTrace {
  readonly availability: "available";
  readonly schemaVersion: "pi-trace/1";
  readonly sessionId: string;
  readonly sourceVersion: string;
  readonly selectorVersion: string;
  readonly activeLeafId: string | null;
  readonly activeBranchIds: readonly string[];
  readonly records: readonly TraceRecord[];
  readonly selection: {
    readonly selectorVersion: string;
    readonly manifestHash: string;
    readonly rarebitSourceEntryIds: readonly string[];
  };
}

export interface TraceUnavailable {
  readonly availability: "unavailable";
  readonly reason: string;
  readonly message: string;
}
