export type TraceLane = "input" | "model" | "tools";

interface TraceContentBase {
  readonly sourceBlockIndex: number;
}

export interface ProseContentBlock extends TraceContentBase {
  readonly kind: "prose";
  readonly text: string;
}

export interface ReasoningContentBlock extends TraceContentBase {
  readonly kind: "reasoning";
  readonly text: string;
}

export interface ToolCallContentBlock extends TraceContentBase {
  readonly kind: "tool_call";
  readonly id: string | null;
  readonly name: string;
  readonly arguments: unknown;
  readonly toolResultRecordId?: string | null;
}

export interface ToolResultContentBlock extends TraceContentBase {
  readonly kind: "tool_result";
  readonly text: string;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly isError: boolean;
}

export interface UnsupportedContentBlock extends TraceContentBase {
  readonly kind: "unsupported";
  readonly nativeType: string | null;
  readonly reason: string;
  readonly raw: unknown;
}

export type TraceContentBlock =
  | ProseContentBlock
  | ReasoningContentBlock
  | ToolCallContentBlock
  | ToolResultContentBlock
  | UnsupportedContentBlock;

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
  readonly content: readonly TraceContentBlock[];
  readonly rarebit: boolean;
  readonly details: {
    readonly stopReason?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly isError?: boolean;
    readonly usage?: Record<string, unknown>;
  };
  readonly toolCallRecordId?: string | null;
  readonly unavailable: Record<string, string>;
  readonly raw: unknown;
}

export interface PiTrace {
  readonly availability: "available";
  readonly schemaVersion: "pi-trace/2";
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
