// Request keys of `thread.submit`. pi-durable returns the existing submission for a reused request ID and checks only
// its type. A key belongs to one message, so the node stores the message's digest beside the key and refuses the key
// for a different message. A key without a stored digest (an older store, or one evicted) keeps pi-durable's behavior.

import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";
import { NodeError, type NodeRuntime } from "./runtime.ts";

const KEEP_KEYS = 1000;

export type SubmitKeysState = { keys: Record<string, { digest: string; at: number }> };
export const SubmitKeysDoc = defineDoc<SubmitKeysState>({
	kind: "ampi.submit-keys",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	// A fork admits its own messages.
	fork: "initial",
	initial: () => ({ keys: {} }),
});

export type SubmitPayload = { text: string; whenBusy: string; images: readonly { data: string; mimeType: string }[] };

/** The digest of a message: its text, its busy mode, and each image's type and data digest, in order. */
export function submitDigest(payload: SubmitPayload): string {
	const images = payload.images.map((image) => [image.mimeType, createHash("sha256").update(image.data).digest("hex")]);
	return createHash("sha256").update(JSON.stringify([payload.text, payload.whenBusy, images])).digest("hex");
}

type Thread = Awaited<ReturnType<NodeRuntime["thread"]>>;

/**
 * Binds `requestId` to `digest` before the submission, so a key never admits a second message. Throws `key_conflict`
 * when the key already names a different message. Callers hold the thread's admission.
 */
export async function claimSubmitKey(thread: Thread, requestId: string, digest: string): Promise<void> {
	const id = Number(thread.conversationId) as ConversationId;
	const stored = (await thread.store.harness.snapshot(SubmitKeysDoc, id, BACKGROUND_CONTEXT))?.keys[requestId];
	if (stored?.digest === digest) return;
	if (stored) throw new NodeError("key_conflict", `Request key ${requestId} already names a different message. Send this message with a new key.`);
	await thread.store.harness.commit(async (tx) => {
		const doc = await tx.doc(SubmitKeysDoc, id);
		doc.keys[requestId] = { digest, at: Date.now() };
		const keys = Object.keys(doc.keys);
		if (keys.length > KEEP_KEYS)
			for (const old of keys.sort((a, b) => doc.keys[a]!.at - doc.keys[b]!.at).slice(0, keys.length - KEEP_KEYS)) delete doc.keys[old];
	}, BACKGROUND_CONTEXT);
}
