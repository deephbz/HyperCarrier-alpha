// Slash commands of a durable thread (node-design.md, Slash commands). The command set follows HC Control
// (packages/pi-hc-control): the same built-ins, the same pane-only list, the same replies. Every command is typed:
// there is no `dispatched` disposition. A command with a `key` stores its intent before the effect and its reply
// after, in the conversation's `ampi.commands` document, so a retry after a lost reply or a node kill returns the first
// reply and runs the effect at most once. The key belongs to that command: another name or other arguments get
// `key_conflict`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, CompactionTask, type ConversationId, defineDoc, type EntryRecord, LiveDoc } from "@earendil-works/pi-durable";
import type { CommandAck, SlashCommand, SlashCommands } from "../shared/protocol.ts";
import { expandTemplate } from "../shared/prompt-template.ts";
import { frontmatter, loadPrompts, loadSkills } from "./core-extension.ts";
import { NodeError, type NodeRuntime, parseThreadKey, type Store } from "./runtime.ts";
import { CacheTtlDoc } from "../plugins/cache-goblin.ts";
import { rarebitCommand } from "../plugins/rarebit.ts";
import { compactCommand } from "../plugins/compact.ts";
import { auditSnapshot } from "../plugins/prompt-audit.ts";
import { homedir } from "node:os";
import { ptbCommand } from "./ptb-command.ts";

const BUILTINS: [name: string, description: string, argsHint: string][] = [
	["model", "Set the model", "<provider/model>"],
	["thinking", "Set the thinking level", "<level>"],
	["name", "Set the thread's display name", "<name>"],
	["compact", "Compact the thread's context", "[instructions]"],
	["auto-compact", "Show or change this thread's compaction policy", "status|run|on|off|budget|threshold|help"],
	["rarebit", "Read Rarebits or derive a Title", "status|title|view|menu|help"],
	["retry", "Run parked work again, or reopen a failed storage", ""],
	["cache", "Show or set the prompt cache TTL", "status|5m|1h"],
	["ptb", "Read the bound Team", "help|status|sync|graph|doctor|settings"],
	["export-system-prompt", "Save the effective system prompt and tools for review", "[file.json]"],
];
/** Pi's TUI built-ins: they act on a Pi pane, and a durable thread has none. */
const PANE_ONLY = ["settings", "tree", "scoped-models", "export", "import", "share", "bug", "copy", "session",
	"changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "resume", "reload", "quit"];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const NAME = /^[A-Za-z0-9][\w:.-]*$/;
const KEEP_KEYS = 200;

/** One keyed command: its intent, committed before the effect, and its reply, committed after it. */
export type CommandRecord = { name: string; args: string; at: number; after: number | null; reply?: CommandAck };
export type CommandsState = { keys: Record<string, CommandRecord>; retired?: Record<string, true> };
/** Admission returns the wait as data, so Close never queues behind a provider. */
export type CommandResult = CommandAck | { completion: Promise<CommandAck> };
const pendingCommands = new WeakMap<NodeRuntime, Map<string, Promise<CommandAck>>>();
const keyDigest = (key: string) => createHash("sha256").update(key).digest("hex");
function replay(reply: CommandAck): CommandAck {
	const copy = structuredClone(reply);
	delete copy.panel;
	return copy;
}
export const CommandsDoc = defineDoc<CommandsState>({
	kind: "ampi.commands",
	version: 1,
	checkpointWhen: () => false,
	scope: "conversation",
	history: "latest",
	// A fork answers its own commands.
	fork: "initial",
	initial: () => ({ keys: {} }),
});

export type CommandArgs = { threadId: string; name: string; args?: string; key?: string; abort?: boolean; whenBusy?: "steer" | "followUp" };
type Thread = Awaited<ReturnType<NodeRuntime["thread"]>>;

const refOf = (model: { provider: string; modelId?: string; id?: string }) => `${model.provider}/${model.modelId ?? model.id}`;

async function cwdOf(thread: Thread): Promise<string> {
	return (await thread.store.harness.snapshot(AgentDoc, Number(thread.conversationId) as ConversationId, BACKGROUND_CONTEXT))?.cwd ?? homedir();
}

async function reasoning(runtime: NodeRuntime, thread: Thread): Promise<boolean> {
	const model = (await thread.store.harness.snapshot(AgentDoc, Number(thread.conversationId) as ConversationId, BACKGROUND_CONTEXT))?.model;
	return model ? runtime.models.getModel(model.provider, model.modelId)?.reasoning === true : false;
}

/** `thread.commands`: built-ins first, as in Pi's TUI, then the thread's prompt templates and skills. */
export async function listCommands(runtime: NodeRuntime, key: string): Promise<SlashCommands> {
	const thread = await runtime.thread(key);
	const cwd = await cwdOf(thread);
	const agent = await thread.store.harness.snapshot(AgentDoc, Number(thread.conversationId) as ConversationId, BACKGROUND_CONTEXT);
	const commands: SlashCommand[] = [
		...BUILTINS.map(([name, description, argsHint]) => ({ name, description, argsHint, source: "builtin" as const, supported: true })),
		...PANE_ONLY.map((name) => ({ name, source: "builtin" as const, supported: false })),
		...loadPrompts(cwd, runtime.piConfig).map(({ name, description }) => ({ name, ...(description ? { description } : {}), source: "prompt" as const, supported: true })),
		...loadSkills(cwd, runtime.piConfig).map(({ name, description }) => ({ name: `skill:${name}`, ...(description ? { description } : {}), source: "skill" as const, supported: true })),
	];
	return {
		commands,
		models: (await runtime.listModels()).map((m) => ({ ref: `${m.provider}/${m.id}`, ...(m.name ? { name: m.name } : {}) })),
		model: agent?.model ? refOf(agent.model) : null,
		thinkingLevels: (await reasoning(runtime, thread)) ? THINKING_LEVELS : ["off"],
		thinking: agent?.thinkingLevel ?? "off",
	};
}

/** Pi's skill message (pi-coding-agent `/skill:` expansion): the skill file without frontmatter, then the arguments. */
export function expandSkill(name: string, path: string, args: string): string {
	const { body } = frontmatter(readFileSync(path, "utf8"));
	const block = `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body.trim()}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
}

/** Command admission and reply storage serialize with Close; provider waits run outside that section. */
export function runCommand(runtime: NodeRuntime, frame: CommandArgs): Promise<CommandAck> {
	if (typeof frame.name !== "string" || !NAME.test(frame.name)) throw new NodeError("bad_request", "name must be a command name without the leading slash.");
	if (frame.args !== undefined && typeof frame.args !== "string") throw new NodeError("bad_request", "args must be a string.");
	if (frame.key !== undefined && (typeof frame.key !== "string" || !frame.key)) throw new NodeError("bad_request", "key must be a nonempty string.");
	if (frame.whenBusy !== undefined && frame.whenBusy !== "steer" && frame.whenBusy !== "followUp") throw new NodeError("bad_request", 'whenBusy must be "steer" or "followUp".');
	// A failed storage has no thread to admit to: /retry reopens it once, as `store.reopen` does.
	if (frame.name === "retry") {
		const { storeId } = parseThreadKey(frame.threadId);
		if (runtime.unavailable(storeId)) return reopened(runtime, storeId);
	}
	let pending = pendingCommands.get(runtime);
	if (!pending) pendingCommands.set(runtime, pending = new Map());
	const pendingId = JSON.stringify([frame.threadId, frame.key]);
	return runtime.admit<CommandResult>(frame.threadId, async (thread) => {
		const args = (frame.args ?? "").trim();
		if (!frame.key) return execute(runtime, thread, frame, args, undefined);
		const doc = (store: Store) => store.harness.snapshot(CommandsDoc, Number(thread.conversationId) as ConversationId, BACKGROUND_CONTEXT);
		const state = await doc(thread.store);
		if (state?.retired?.[keyDigest(frame.key)]) throw new NodeError("command_expired", "The node no longer knows this command's result. Press Enter to run it again.");
		const stored = state?.keys[frame.key];
		// A key belongs to one command: another command under it gets a refusal, never the first reply.
		if (stored && (stored.name !== frame.name || stored.args !== args))
			throw new NodeError("key_conflict", `Command key ${frame.key} already names /${stored.name}${stored.args ? ` ${stored.args}` : ""}. Run this command with a new key.`);
		if (stored?.reply) return replay(stored.reply);
		const active = pending!.get(pendingId);
		if (active) return { completion: active.then(replay) };
		const intent = stored ?? { name: frame.name, args, at: Date.now(), after: await newestEntry(thread) };
		if (!stored) await commitRecord(thread, frame.key, intent);
		const result = await execute(runtime, thread, frame, args, stored ? intent : undefined);
		if ("completion" in result) {
			const completion = result.completion.then(reply => runtime.admit(frame.threadId, async current => {
				await commitRecord(current, frame.key!, { ...intent, reply });
				return reply;
			})).finally(() => pending!.delete(pendingId));
			pending!.set(pendingId, completion);
			return { completion };
		}
		await commitRecord(thread, frame.key, { ...intent, reply: result });
		return result;
	}).then(result => "completion" in result ? result.completion : result);
}

async function newestEntry(thread: Thread): Promise<number | null> {
	const page = await thread.conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT);
	const entry = (page.items as readonly EntryRecord[])[0];
	return entry ? Number(entry.id) : null;
}

async function commitRecord(thread: Thread, key: string, record: CommandRecord): Promise<void> {
	await thread.store.harness.commit(async (tx) => {
		const doc = await tx.doc(CommandsDoc, Number(thread.conversationId) as ConversationId);
		// A result that settles after eviction must not resurrect its old key.
		if (doc.retired?.[keyDigest(key)]) return;
		doc.keys[key] = structuredClone(record);
		const keys = Object.keys(doc.keys);
		if (keys.length > KEEP_KEYS) {
			// Opaque keys have no trustworthy age. Keep digests for the conversation lifetime.
			doc.retired ??= {};
			for (const old of keys.sort((a, b) => doc.keys[a]!.at - doc.keys[b]!.at).slice(0, keys.length - KEEP_KEYS)) {
				doc.retired[keyDigest(old)] = true;
				delete doc.keys[old];
			}
		}
	}, BACKGROUND_CONTEXT);
}

async function reopened(runtime: NodeRuntime, storeId: string): Promise<CommandAck> {
	const result = await runtime.reopenStore(storeId);
	if (result.state === "open") return { ...handled("Storage reopened"), evidence: "store_reopened" };
	if (result.state === "reopening") return { ...handled(`Storage is still reopening: ${result.error}`), evidence: "store_reopening" };
	throw new NodeError("unavailable", `Storage did not reopen: ${result.error}`);
}

const handled = (notice: string, effect?: CommandAck["effect"]): CommandAck => ({ via: "node", disposition: "handled", notice, ...(effect ? { effect } : {}) });

/**
 * Runs one command's effect. `retried` is a stored intent without a reply: the node died between them, so an effect
 * that is not idempotent first looks for its own trace.
 */
async function execute(runtime: NodeRuntime, thread: Thread, frame: CommandArgs, args: string, retried: CommandRecord | undefined): Promise<CommandResult> {
	const { name } = frame;
	const id = Number(thread.conversationId) as ConversationId;
	switch (name) {
		case "ptb": return ptbCommand(runtime, thread, args);
		case "model": {
			if (!args) throw new NodeError("bad_args", "Name a model: /model <provider/id>.");
			const models = await runtime.listModels();
			const slash = args.indexOf("/");
			const exact = slash > 0 ? models.filter((m) => m.provider === args.slice(0, slash) && m.id === args.slice(slash + 1)) : [];
			const matches = exact.length ? exact : models.filter((m) => m.id === args);
			if (matches.length !== 1)
				throw new NodeError("bad_args", matches.length ? `"${args}" names ${matches.length} models; use one of: ${matches.map((m) => `${m.provider}/${m.id}`).join(", ")}.` : `No available model matches "${args}".`);
			const model = matches[0]!;
			const busy = (await thread.store.harness.snapshot(LiveDoc, id, BACKGROUND_CONTEXT))?.run !== undefined;
			await thread.conversation.configure({ model: { provider: model.provider, modelId: model.id } }, BACKGROUND_CONTEXT);
			const ref = `${model.provider}/${model.id}`;
			// A running turn uses the model from its next model request, as in Pi.
			return handled(`Model: ${ref}${busy ? " (from the next model request)" : ""}`, { model: ref });
		}
		case "thinking": {
			if (!THINKING_LEVELS.includes(args)) throw new NodeError("bad_args", `Thinking level must be one of: ${THINKING_LEVELS.join(", ")}.`);
			const before = (await thread.store.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT))?.thinkingLevel ?? "off";
			// Pi clamps to what the model supports; a model without reasoning has only "off".
			const level = (await reasoning(runtime, thread)) ? args : "off";
			await thread.conversation.configure({ thinkingLevel: level as never }, BACKGROUND_CONTEXT);
			const applied = (await thread.store.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT))?.thinkingLevel ?? level;
			const notice = applied === args ? `Thinking: ${applied}` : `Thinking: ${applied} (${args} is not available for this model)`;
			return handled(notice, { thinking: applied, requested: args, changed: applied !== before });
		}
		case "name": {
			if (!args) throw new NodeError("bad_args", "Give a name: /name <name>.");
			await runtime.updateMeta(frame.threadId, { title: args });
			return handled(`Name: ${args}`, { name: args });
		}
		case "rarebit": return rarebitCommand(thread.store, thread.conversationId, args, frame.key);
		case "auto-compact": {
			if (/^run(?:\s|$)/.test(args)) {
				const result = await execute(runtime, thread, { ...frame, name: "compact" }, args.replace(/^run\s*/, ""), retried);
				const notice = (reply: CommandAck) => ({ ...reply, notice: "Same as /compact: compacting now" });
				return "completion" in result ? { completion: result.completion.then(notice) } : notice(result);
			}
			return compactCommand(runtime, thread, args);
		}
		case "compact": {
			const reply = { ...handled("Compaction started"), evidence: "compaction_started" };
			if (retried && (await compactedSince(thread, retried.after))) return reply;
			const busy = (await thread.store.harness.snapshot(LiveDoc, id, BACKGROUND_CONTEXT))?.run !== undefined;
			// Compaction of a running turn stops the turn first; that must be the owner's explicit choice.
			if (busy && frame.abort !== true) throw new NodeError("busy", "Compact stops the running turn. Send again with abort to stop and compact.");
			if (busy) return { completion: thread.conversation.abort(BACKGROUND_CONTEXT)
				.then(() => runtime.admit(frame.threadId, current => execute(runtime, current, { ...frame, abort: false }, args, retried)))
				.then(result => "completion" in result ? result.completion : result) };
			await thread.conversation.compact(args || undefined, BACKGROUND_CONTEXT);
			// Test-only kill point of crash-g: the compaction is admitted and the reply is not stored yet.
			if (process.env.AMPI_FAULT === "after-command-effect") process.kill(process.pid, "SIGKILL");
			return reply;
		}
		case "retry": {
			// Only tasks the restart limit parked; a task blocked for another reason needs the node or registry fixed.
			const inspection = await thread.store.harness.inspect(BACKGROUND_CONTEXT);
			const parked = inspection.tasks.filter(
				({ record, state }) => state.kind === "blocked" && state.reason === "restart_limit" && String(record.conversationId) === thread.conversationId,
			);
			for (const { record } of parked) await thread.store.harness.retryTask(record.id, BACKGROUND_CONTEXT);
			// A failed model run keeps the inputs queued behind it (pi-durable `afterFailedRun: "keep"`) until the next
			// input or queued write. An empty edit is a queued write that changes no context, so it places them now.
			const kept = inspection.submissions.some((s) => s.status === "queued" && s.type === "input" && String(s.conversationId) === thread.conversationId);
			const live = await thread.store.harness.snapshot(LiveDoc, Number(thread.conversationId) as ConversationId, BACKGROUND_CONTEXT);
			if (parked.length === 0 && kept && !live?.run) {
				await thread.conversation.submit({ type: "write", entry: { kind: "ampi.retry", edits: [] } }, BACKGROUND_CONTEXT);
				runtime.refresh(thread.store, thread.conversationId);
				return { ...handled("Running the queued input"), evidence: "retried" };
			}
			runtime.refresh(thread.store, thread.conversationId);
			if (parked.length === 0) return { ...handled("Nothing is parked in this thread"), evidence: "nothing_parked" };
			return { ...handled(`Retried ${parked.length} parked task${parked.length === 1 ? "" : "s"}`), evidence: "retried" };
		}
		case "cache": {
			if (args === "" || args === "status") {
				const ttl = (await thread.store.harness.snapshot(CacheTtlDoc, id, BACKGROUND_CONTEXT))?.ttl ?? "5m";
				return handled(`Cache TTL: ${ttl}`);
			}
			if (args !== "5m" && args !== "1h") throw new NodeError("bad_args", "Use /cache status, /cache 5m, or /cache 1h.");
			// Setting the same TTL again is a no-op, so a retried command needs no trace check.
			await thread.store.harness.commit(async (tx) => {
				(await tx.doc(CacheTtlDoc, id)).ttl = args;
			}, BACKGROUND_CONTEXT);
			return handled(`Cache TTL: ${args} (from the next model request)`);
		}
		case "export-system-prompt": {
			const snapshot = await auditSnapshot(thread.conversation, BACKGROUND_CONTEXT);
			if (!snapshot) throw new NodeError("audit_empty", "No system prompt recorded yet for this thread.");
			if (args && !/^[\w.-]+$/.test(args)) throw new NodeError("bad_args", "Give a file name without a directory: /export-system-prompt [file.json].");
			// A command key names the file, so a retried command finds its own file instead of writing a second one.
			const stem = args ? args.replace(/\.json$/, "") : `durable-${frame.threadId}-${frame.key ? frame.key.replace(/[^\w.-]/g, "_") : snapshot.capturedAt.replace(/[:.]/g, "-")}`;
			const dir = join(await cwdOf(thread), ".pi", "prompt-snapshots");
			const path = join(dir, `${stem}.json`);
			mkdirSync(dir, { recursive: true });
			try {
				writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (!retried) throw new NodeError("bad_args", `${path} exists; give another file name.`);
			}
			return handled(`System prompt saved to ${path}`);
		}
	}
	if (PANE_ONLY.includes(name)) throw new NodeError("unsupported_command", `/${name} works only in a Pi pane.`);
	const cwd = await cwdOf(thread);
	let text: string | undefined;
	if (name.startsWith("skill:")) {
		const skill = loadSkills(cwd, runtime.piConfig).find((candidate) => candidate.name === name.slice(6));
		if (skill) text = expandSkill(skill.name, skill.path, args);
	} else {
		const template = loadPrompts(cwd, runtime.piConfig).find((candidate) => candidate.name === name);
		if (template) text = expandTemplate(template.body, args);
	}
	if (text === undefined) throw new NodeError("unknown_command", `This thread has no command /${name}; nothing was sent.`);
	// A skill or template becomes a user message: admission as for submit, deduplicated on the command key.
	const submission = await thread.conversation.submit(
		{ type: "input", content: text, whenBusy: frame.whenBusy ?? "followUp", ...(frame.key ? { requestId: `command:${frame.key}` } : {}) },
		BACKGROUND_CONTEXT,
	);
	const placed = (await submission.status(BACKGROUND_CONTEXT)).status !== "queued";
	return { via: "node", disposition: placed ? "started" : "queued", evidence: placed ? "started" : "admitted", submission: String(submission.id) };
}

/** The trace of an admitted compaction: one still live in this conversation, or its entry after the command's intent. */
async function compactedSince(thread: Thread, after: number | null): Promise<boolean> {
	const inspection = await thread.store.harness.inspect(BACKGROUND_CONTEXT);
	if (inspection.tasks.some(({ record }) => record.kind === CompactionTask.definition.name && String(record.conversationId) === thread.conversationId && record.state.status !== "terminal"))
		return true;
	const page = await thread.conversation.entries(after === null ? {} : { minEntryId: (after + 1) as never }, 200, undefined, BACKGROUND_CONTEXT);
	return (page.items as readonly EntryRecord[]).some((entry) => entry.kind === "pi.compaction");
}
