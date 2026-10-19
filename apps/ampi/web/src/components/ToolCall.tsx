import { type ReactNode, useState } from "react";
import { toolCallState } from "../../../src/shared/tool-state.ts";

export type ToolResult = { text: string; isError: boolean; truncated?: boolean; details?: unknown };
export type LiveSlot = { status: "pending" | "running" | "done"; output?: string; details?: unknown };

// biome-ignore lint: tool arguments are free-form JSON
type Args = Record<string, any>;

function one(value: unknown, max = 160): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function argSummary(name: string, args: Args): string {
	switch (name) {
		case "bash":
			return one(args.command);
		case "read":
			return `${args.path ?? ""}${args.offset ? ` :${args.offset}` : ""}${args.limit ? `+${args.limit}` : ""}`;
		case "write":
			return `${args.path ?? ""}${typeof args.content === "string" ? ` · ${args.content.replace(/\n$/, "").split("\n").length} lines` : ""}`;
		case "edit":
			return `${args.path ?? ""}${Array.isArray(args.edits) ? ` · ${args.edits.length} edit(s)` : ""}`;
		case "task_update":
			return `${args.task_id ?? ""}${args.transition ? ` → ${args.transition}` : ""}${args.current_context ? " · context" : ""}`;
		case "task_graph_apply":
			return `${Array.isArray(args.tasks) ? args.tasks.length : 0} task(s) · ${args.operation_id ?? ""}`;
		case "ensure_worker":
			return `${args.name ?? ""} — ${one(args.scope, 80)}`;
		case "alert_send":
			return `${args.to ? `${args.to} · ` : ""}${args.kind ?? ""}: ${one(args.text, 100)}`;
		case "team_create":
			return `${args.name ?? ""} — ${one(args.purpose, 80)}`;
		default:
			return one(args);
	}
}

export function Diff({ patch }: { patch: string }) {
	const lines = patch.split("\n").filter((line) => !line.startsWith("Index:") && !line.startsWith("===="));
	return (
		<div className="diff">
			{lines.map((line, i) => (
				<div
					key={i}
					className={
						line.startsWith("+++") || line.startsWith("---")
							? "hunk"
							: line.startsWith("+")
								? "add"
								: line.startsWith("-")
									? "del"
									: line.startsWith("@@")
										? "hunk"
										: ""
					}
				>
					{line || " "}
				</div>
			))}
		</div>
	);
}

export function editPatch(args: Args): string {
	const out: string[] = [];
	for (const edit of Array.isArray(args.edits) ? args.edits : []) {
		out.push("@@");
		for (const line of String(edit.oldText ?? "").split("\n")) out.push(`-${line}`);
		for (const line of String(edit.newText ?? "").split("\n")) out.push(`+${line}`);
	}
	return out.join("\n");
}

export function ToolCall({
	name,
	args,
	result,
	live,
	onOpenThread,
	source,
	outputSource,
	callOpen = false,
	active = false,
}: {
	name: string;
	args: Args | null;
	/** Shown in the body when the preview dropped some arguments. */
	source?: ReactNode;
	/** Shown after the output when the preview shortened it; replaces the generic hint. */
	outputSource?: ReactNode;
	result?: ToolResult;
	live?: LiveSlot;
	onOpenThread?: (conversationId: string) => void;
	/** Evidence for toolCallState: the call is still open in the transcript, and the Session runs a turn. */
	callOpen?: boolean;
	active?: boolean;
}) {
	const state = toolCallState({ result, open: callOpen, active });
	const running = state === "running";
	const details = (result?.details ?? live?.details) as Args | undefined;
	const isEdit = name === "edit" || name === "write";
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const expanded = open ?? (running || result?.isError === true || (isEdit && name === "edit"));
	const childConversation = details && typeof details.conversationId !== "undefined" ? String(details.conversationId) : undefined;
	const output = result?.text ?? live?.output ?? "";
	// A running call with no output yet shows what it runs; bash and read otherwise show only their output.
	const waiting = running && output === "";
	const showArgs = args && name !== "edit" && name !== "write" && (waiting || (name !== "bash" && name !== "read"));
	return (
		<div className="tool">
			<div className={`tool-head disclosure${running ? " busy" : ""}`} onClick={() => setOpen(!expanded)} role="button" aria-expanded={expanded}>
				{running && <span className="spinner" />}
				<span className="name">{name}</span>
				<span className="arg">{args ? argSummary(name, args) : "Arguments available in source entry"}</span>
				<span className={`state ${result?.isError ? "err" : result ? "ok" : ""}`}>{state}</span>
			</div>
			{childConversation && onOpenThread && (
				<div className="subthread-link" onClick={() => onOpenThread(childConversation)}>
					↳ Open subthread
				</div>
			)}
			{expanded && (
				<div className="tool-body">
					{source}
					{name === "edit" && args && (details?.patch ? <Diff patch={String(details.patch)} /> : Array.isArray(args.edits) && <Diff patch={editPatch(args)} />)}
					{name === "write" && typeof args?.content === "string" && (
						<pre>{String(args.content ?? "").split("\n").slice(0, 80).join("\n")}</pre>
					)}
					{showArgs && (
						<>
							<div className="label">arguments</div>
							<pre>{JSON.stringify(args, null, 2)}</pre>
						</>
					)}
					{(name !== "edit" || result?.isError) && output !== "" && (
						<>
							{name !== "bash" && name !== "read" && <div className="label">result</div>}
							<pre>{output}</pre>
						</>
					)}
					{waiting && <div className="hint" style={{ padding: "0 12px 8px" }}>waiting for output</div>}
					{outputSource || (result?.truncated && <div className="hint" style={{ padding: "0 12px 8px" }}>Output was shortened for display.</div>)}
				</div>
			)}
		</div>
	);
}
