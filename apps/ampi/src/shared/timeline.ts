// Timeline value types for the wire contract.
// Pi timeline views produce these values; the web timeline reads them.
import type { SourceStatus } from "./source-status.ts";

export type TimelineSession = {
 source: SourceStatus;
 threadId: string; ref: string; title: string; cwd: string; team?: string; role?: string;
 start: number; end: number; live: boolean; waiting: boolean; blocked: boolean;
 /** Rarebit message count. */
 messages: number;
 marks: [number, string, "stop" | "error"][]; buckets: [number, number, number][];
 /** Whether any entry reported a price; the buckets count history entries (spend.ts HISTORY_COVERS). */
 priced: boolean;
 entries: [number, string][]; entryCount: number; omittedHints: number; omittedMarks: number;
};

export type TimelineValue = { bucketMs: number; sessions: TimelineSession[]; unreadable?: { threadId: string; ref: string; title: string; message: string }[] };
