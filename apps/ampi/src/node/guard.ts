// Defense in depth behind the stop fence: a tool call in a closed or fenced conversation is blocked before its
// intent commits. With AMPI_ENTRY_LOG set, every model request and tool call appends one JSON line naming its
// store and conversation, so crash tests prove from recorded entry points what ran after a stop or a restart. With
// AMPI_STOP_LOG set, the stop fence appends each mark and settlement there, in order.

import { appendFileSync, existsSync } from "node:fs";
import type { Context } from "@earendil-works/chord/context";
import { CompactionTask, defineExtension, type Extension, GenerationTask, type HookApi, hook, ToolTask } from "@earendil-works/pi-durable";
import { MetaDoc } from "./runtime.ts";

export const GUARD_EXTENSION = "ampi.guard";

export function toolBlockReason(state: "closed" | "stopped"): string {
	return state === "closed" ? "This thread is closed." : "This work was stopped.";
}

/** Appends one stop-fence line when AMPI_STOP_LOG names a file. */
export function recordStop(line: { kind: "mark" | "settled"; store: string; intent: string; [key: string]: unknown }): void {
	const path = process.env.AMPI_STOP_LOG;
	if (path) appendFileSync(path, `${JSON.stringify(line)}\n`);
}

/** Test seam: with AMPI_STOP_LATCH set, every settlement waits until that file exists. Marks never wait. */
export async function stopLatch(): Promise<void> {
	const path = process.env.AMPI_STOP_LATCH;
	while (path && !existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 20));
}

function record(kind: "model" | "tool" | "compact", store: string | undefined, api: HookApi, name?: string): void {
	const path = process.env.AMPI_ENTRY_LOG;
	if (path) appendFileSync(path, `${JSON.stringify({ kind, store, conversation: String(api.conversationId), task: String(api.taskId), ...(name ? { name } : {}) })}\n`);
}

/** The runtime checks the same owner-chain lifecycle authority used by model dispatch. */
export function nodeGuard(blocked: (storeId: string, conversationId: string) => Promise<"closed" | "stopped" | undefined>): Extension {
	const meta = (api: HookApi, context: Context) => api.snapshot(MetaDoc, context);
	return defineExtension({
		name: GUARD_EXTENSION,
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (_request, api, context) => {
					if (process.env.AMPI_ENTRY_LOG) record("model", (await meta(api, context))?.store, api);
					return undefined;
				},
			}),
			hook(CompactionTask, {
				beforeCompact: async (_compaction, api, context) => {
					if (process.env.AMPI_ENTRY_LOG) record("compact", (await meta(api, context))?.store, api);
					return undefined;
				},
			}),
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const state = await meta(api, context);
					record("tool", state?.store, api, call.name);
					const conversation = String(api.conversationId);
					const reason = state?.store === undefined ? undefined : await blocked(state.store, conversation);
					if (reason !== undefined) return { block: toolBlockReason(reason) };
					return undefined;
				},
			}),
		],
	});
}
