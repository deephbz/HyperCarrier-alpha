// Read committed pi.system evidence through the owning node. No live prompt rebuild or second prompt log.
import type { Context } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { Tool } from "@earendil-works/pi-ai";
import type { Conversation, EntryId } from "@earendil-works/pi-durable";
// @ts-expect-error The existing audit renderer/export package publishes JavaScript without declarations.
import { createSystemPromptExport } from "@hypercarrier/systemp-prompt-audit/system-prompt-export.mjs";

export type PromptAuditSnapshot = {
	schemaVersion: 1;
	capturedAt: string;
	cwd: string;
	systemPrompt: string;
	activeTools: (Tool & { sourceInfo: null })[];
	provenance: {
		systemPrompt: string;
		toolDefinitions: string;
		limitation: string;
		conversationId: string;
		entryId: string;
	};
	integrity: { contentSha256: string };
};

/** Undefined means this context has no recorded system prompt yet. `entryId` selects a historical view. */
export async function auditSnapshot(
	conversation: Conversation,
	context: Context,
	options: { entryId?: EntryId; now?: Date } = {},
): Promise<PromptAuditSnapshot | undefined> {
	const view = await conversation.context(context, options.entryId === undefined ? undefined : { at: options.entryId });
	const recorded = view.entries.findLast((entry) => entry.kind === "pi.system");
	if (!recorded) return undefined;
	const agent = await conversation.agent(context);
	if (!agent.cwd) throw new Error("Prompt audit needs the conversation's working directory");
	const tools = getCurrentTools(view.messages);
	const snapshot = createSystemPromptExport({
		cwd: agent.cwd,
		systemPrompt: getCurrentSystemPrompt(view.messages),
		activeToolNames: tools.map((tool) => tool.name),
		allTools: tools,
	}, options.now);
	return {
		...snapshot,
		provenance: {
			systemPrompt: "pi.system replay through conversation.context",
			toolDefinitions: "pi.system tool additions and removals",
			limitation: "Committed context before provider-payload rewrites. cwd is the current conversation directory; source files are not recorded.",
			conversationId: String(conversation.id),
			entryId: String(options.entryId ?? view.entries.at(-1)!.id),
		},
	};
}
