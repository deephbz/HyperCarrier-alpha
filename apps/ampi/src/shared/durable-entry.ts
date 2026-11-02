// Durable entry types for the wire contract.
// Node projections produce these values; hub and web transcript consumers read them.
import type { JsonValue } from "@earendil-works/chord";
import type { InjectedMessage } from "./protocol.ts";

export type UiBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string; clipped?: boolean }
	| { type: "tool"; callId: string; name: string; args: JsonValue; argsClipped?: boolean }
	| { type: "image"; mimeType: string };

/** A card the preview shortened at its own bound; the card offers the source entry of `clippedBytes` UTF-8 bytes. */
export type Clipped = { clipped?: boolean; clippedBytes?: number };

export type UiEntry = { bodyAvailable?: boolean } & (
	| { id: string; kind: "user"; ts?: number; text: string; images: number; as?: string; data?: JsonValue }
	| {
			id: string;
			kind: "assistant";
			ts?: number;
			blocks: UiBlock[];
			stop?: string;
			error?: string;
			model?: string;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	  }
	| ({
			id: string;
			kind: "tool-result";
			ts?: number;
			callId: string;
			name: string;
			isError: boolean;
			text: string;
			truncated: boolean;
			details?: JsonValue;
	  } & Clipped)
	| ({ id: string; kind: "compaction"; summary: string; reason?: string; ts?: number; byTaskId?: string } & Clipped)
	| { id: string; kind: "reset"; handoff?: string; ts?: number }
	| { id: string; kind: "system"; changed: string[] }
	| ({ id: string; kind: "custom"; entryKind: string; ts?: number; data?: JsonValue; text?: string; message?: InjectedMessage } & Clipped));

export type UiThreadView = {
	/** Content key for bounded Pi pages and body reads. */
	sourceVersion?: string;
	conversationId: string;
	parent?: { conversationId: string; at: string };
	owner?: { conversationId: string; taskId: string };
	/** Entries before the active context's head that this view does not carry (compacted or reset away). */
	hiddenBefore: boolean;
	entries: UiEntry[];
	live: JsonValue;
	inbox: JsonValue;
	agent: JsonValue;
	usage: JsonValue;
};
