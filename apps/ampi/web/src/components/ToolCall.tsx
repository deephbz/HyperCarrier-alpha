import { type ReactNode, useState } from "react";
import type { ToolArgsPreview } from "../../../src/shared/protocol.ts";
import { toolCallState } from "../../../src/shared/tool-state.ts";

export type ToolResult = { text: string; isError: boolean; truncated?: boolean };
export type LiveSlot = { status: "pending" | "running" | "done"; output?: string };

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

export function editPatch(edits: NonNullable<ToolArgsPreview["edits"]>): string {
	const out: string[] = [];
	for (const edit of edits) {
		out.push("@@");
		for (const line of edit.oldText.split("\n")) out.push(`-${line}`);
		for (const line of edit.newText.split("\n")) out.push(`+${line}`);
	}
	return out.join("\n");
}

/** A tool call's whole arguments, as the source entry holds them: the targets, then the change as JSON, then the rest as-is. */
export function ToolArgs({ args }: { args: ToolArgsPreview }) {
	const targets = [args.command, args.path, ...(args.paths ?? [])].filter((x) => x !== undefined).join("\n");
	const change = args.edits || args.content !== undefined ? JSON.stringify({ edits: args.edits, content: args.content }, null, 2) : undefined;
	return (
		<>
			{targets !== "" && <pre>{targets}</pre>}
			{change !== undefined && <pre>{change}</pre>}
			{args.text !== undefined && <pre>{args.text}</pre>}
		</>
	);
}

export function ToolCall({
	name,
	args,
	result,
	live,
	source,
	outputSource,
	callOpen = false,
	active = false,
}: {
	name: string;
	/** Null when the source entry alone has the arguments. */
	args: ToolArgsPreview | null;
	/** Shown in the body when the preview dropped some arguments. */
	source?: ReactNode;
	/** Shown after the output when the preview shortened it; replaces the generic hint. */
	outputSource?: ReactNode;
	result?: ToolResult;
	live?: LiveSlot;
	/** Evidence for toolCallState: the call is still open in the transcript, and the Session runs a turn. */
	callOpen?: boolean;
	active?: boolean;
}) {
	const state = toolCallState({ result, open: callOpen, active });
	const running = state === "running";
	const isEdit = name === "edit" || name === "write";
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const expanded = open ?? (running || result?.isError === true || (isEdit && name === "edit"));
	const output = result?.text ?? live?.output ?? "";
	// A running call with no output yet shows what it runs; bash and read otherwise show only their output.
	const waiting = running && output === "";
	const cut = args?.omitted;
	const shown =
		args && name !== "edit" && name !== "write" && (waiting || (name !== "bash" && name !== "read"))
			? [
					args.command,
					cut?.command && "…command shortened",
					args.path,
					...(args.paths ?? []),
					cut?.paths && `+${cut.paths} more paths`,
					args.text,
				]
					.filter((x) => typeof x === "string")
					.join("\n")
			: "";
	return (
		<div className="tool">
			<div className={`tool-head disclosure${running ? " busy" : ""}`} onClick={() => setOpen(!expanded)} role="button" aria-expanded={expanded}>
				{running && <span className="spinner" />}
				<span className="name">{name}</span>
				<span className="arg">{args ? args.summary : "Arguments available in source entry"}</span>
				<span className={`state ${result?.isError ? "err" : result ? "ok" : ""}`}>{state}</span>
			</div>
			{expanded && (
				<div className="tool-body">
					{source}
					{name === "edit" && args?.edits && <Diff patch={editPatch(args.edits)} />}
					{name === "write" && args?.content !== undefined && <pre>{args.content.split("\n").slice(0, 80).join("\n")}</pre>}
					{shown !== "" && (
						<>
							<div className="label">arguments</div>
							<pre>{shown}</pre>
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
