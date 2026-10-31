import { useEffect, useMemo, useState } from "react";
import type { PiEntry } from "../../../src/shared/protocol.ts";
import { hub, useTopic } from "../client.ts";
import { clock, href } from "../util.ts";
import { Diff, editPatch } from "./ToolCall.tsx";

type Change = { entryId: string; ts?: number; tool: "edit" | "write"; patch: string; failed: boolean };

function count(patch: string): { add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) add++;
		else if (line.startsWith("-")) del++;
	}
	return { add, del };
}

type GitChanges = { repo: false } | { repo: true; root: string; branch: string; files: { status: string; path: string }[]; patch: string; truncated: boolean };

const STATUS: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", "?": "untracked", U: "conflict" };

/** Split a `git diff` into per-file patches keyed by the new path. */
function byFile(patch: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of patch.split(/^(?=diff --git )/m)) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
		if (header) out.set(header[2]!, part.split("\n").filter((l) => !/^(diff --git|index |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l)).join("\n"));
	}
	return out;
}

/** What is different in the thread's repository now, whoever changed it: tools, bash, Team Workers, or the owner. */
function WorkingTree({ host, cwd, refreshKey }: { host: string; cwd?: string; refreshKey?: string }) {
	const [git, setGit] = useState<GitChanges>();
	const [error, setError] = useState<string>();
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [tick, setTick] = useState(0);
	useEffect(() => {
		let live = true;
		hub.request(host, "git.changes", { cwd }).then(
			(r) => live && (setGit(r), setError(undefined)),
			(e) => live && setError((e as Error).message),
		);
		return () => {
			live = false;
		};
	}, [host, cwd, refreshKey, tick]);
	if (error) return <div className="err-box">{error}</div>;
	if (!git) return <div className="hint">Reading the working tree…</div>;
	if (!git.repo) return <div className="hint">{cwd} is not in a Git repository, so only the thread's own edits are listed below.</div>;
	const patches = byFile(git.patch);
	return (
		<div data-working-tree>
			<h3 style={{ display: "flex", alignItems: "center" }}>
				<span>
					Working tree · {git.files.length} file{git.files.length === 1 ? "" : "s"} differ from {git.branch || "HEAD"}
				</span>
				<span style={{ flex: 1 }} />
				<button className="btn ghost small" title="Read the working tree again" onClick={() => setTick((t) => t + 1)}>
					↻
				</button>
			</h3>
			<div className="hint" style={{ marginBottom: 6 }}>
				{git.root} · every change since the last commit, including Team Workers', bash's, and yours.
				{git.truncated ? " The diff is long; it is cut at 2 MB." : ""}
			</div>
			{git.files.length === 0 && <div className="hint">Clean: nothing differs from the last commit.</div>}
			{git.files.map((file) => {
				const path = file.path.includes(" -> ") ? file.path.split(" -> ")[1]! : file.path;
				const patch = patches.get(path);
				const n = patch ? count(patch) : undefined;
				const code = file.status.trim()[0] ?? "?";
				const expanded = open.has(path);
				return (
					<div key={file.path} className="change-file" data-git-file={path}>
						<div
							className="change-row"
							onClick={() =>
								setOpen((prev) => {
									const next = new Set(prev);
									if (next.has(path)) next.delete(path);
									else next.add(path);
									return next;
								})
							}
						>
							<span className="caret">{patch ? (expanded ? "▾" : "▸") : " "}</span>
							<code className="path" title={file.path}>
								<b>{path.slice(path.lastIndexOf("/") + 1)}</b>
								{path.includes("/") && <span className="dir"> {path.slice(0, path.lastIndexOf("/") + 1)}</span>}
							</code>
							<span className="grow" />
							{n && (
								<>
									<span className="add">+{n.add}</span> <span className="del">−{n.del}</span>{" "}
								</>
							)}
							<span className="hint">· {STATUS[code] ?? file.status.trim()}</span>
						</div>
						{expanded && patch && (
							<div className="change-step">
								<Diff patch={patch} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

/**
 * What changed: the repository's working tree first (the truth to review), then every file this thread's agent
 * edited or wrote, over the full durable history (the explanation; compaction hides nothing here).
 */
export function ChangesPanel({ host, threadId }: { host: string; threadId: string }) {
	const { value: view } = useTopic(host, { kind: "thread", threadId });
	const [history, setHistory] = useState<PiEntry[]>();
	const [open, setOpen] = useState<Set<string>>(new Set());
	const lastId = view?.entries.at(-1)?.id;
	useEffect(() => {
		let live = true;
		(async () => {
			const all: PiEntry[] = [];
			let before = String(Number(lastId ?? 0) + 1);
			for (let page = 0; page < 40; page++) {
				const r = await hub.request(host, "thread.history", { threadId, before, limit: 500 });
				all.unshift(...r.entries);
				if (!r.more || r.entries.length === 0) break;
				before = r.entries[0]!.id;
			}
			if (live) setHistory(all);
		})().catch(() => live && setHistory([]));
		return () => {
			live = false;
		};
	}, [host, threadId, lastId]);
	const files = useMemo(() => {
		const results = new Map<string, Extract<PiEntry, { kind: "tool-result" }>>();
		for (const e of history ?? []) if (e.kind === "tool-result") results.set(e.callId, e);
		const byPath = new Map<string, Change[]>();
		for (const e of history ?? []) {
			if (e.kind !== "assistant") continue;
			for (const block of e.blocks) {
				if (block.type !== "tool" || (block.name !== "edit" && block.name !== "write")) continue;
				const { args } = block;
				const path = args.path ?? "";
				if (!path) continue;
				const result = results.get(block.callId);
				const patch =
					block.name === "edit"
						? editPatch(args.edits ?? [])
						: (args.content ?? "")
								.replace(/\n$/, "")
								.split("\n")
								.map((l: string) => `+${l}`)
								.join("\n");
				const list = byPath.get(path) ?? [];
				list.push({ entryId: e.id, ts: e.ts, tool: block.name, patch, failed: result?.isError === true || result === undefined });
				byPath.set(path, list);
			}
		}
		return [...byPath.entries()].sort((a, b) => Number(b[1].at(-1)!.entryId) - Number(a[1].at(-1)!.entryId));
	}, [history]);
	const cwd = view?.agent.cwd;
	const tree = <WorkingTree host={host} cwd={cwd} refreshKey={lastId} />;
	if (!history)
		return (
			<div data-panel="changes">
				{tree}
				<div className="empty">Loading…</div>
			</div>
		);
	if (files.length === 0)
		return (
			<div data-panel="changes">
				{tree}
				<h3>This thread's edits</h3>
				<div className="hint">This thread's agent has not used edit or write. Team Workers' edits are in their own threads.</div>
			</div>
		);
	return (
		<div data-panel="changes">
			{tree}
			<h3>
				This thread's edits · {files.length} file{files.length === 1 ? "" : "s"}
			</h3>
			{files.map(([path, changes]) => {
				const done = changes.filter((c) => !c.failed);
				const total = done.reduce((acc, c) => {
					const n = count(c.patch);
					return { add: acc.add + n.add, del: acc.del + n.del };
				}, { add: 0, del: 0 });
				const expanded = open.has(path);
				return (
					<div key={path} className="change-file" data-change-file={path}>
						<div
							className="change-row"
							onClick={() =>
								setOpen((prev) => {
									const next = new Set(prev);
									if (next.has(path)) next.delete(path);
									else next.add(path);
									return next;
								})
							}
						>
							<span className="caret">{expanded ? "▾" : "▸"}</span>
							<code className="path" title={path}>
								<b>{path.slice(path.lastIndexOf("/") + 1)}</b>
								{path.includes("/") && <span className="dir"> {path.slice(0, path.lastIndexOf("/") + 1)}</span>}
							</code>
							<span className="grow" />
							<span className="add">+{total.add}</span> <span className="del">−{total.del}</span>
							<span className="hint">
								{" "}
								· {done.length} change{done.length === 1 ? "" : "s"}
								{changes.length > done.length ? ` · ${changes.length - done.length} failed` : ""}
							</span>
						</div>
						{expanded &&
							changes.map((c, i) => (
								<div key={i} className="change-step">
									<div className="hint">
										{c.tool} · {clock(c.ts)}
										{c.failed ? " · failed, not applied" : ""} ·{" "}
										<a href={href.thread(host, threadId, { entry: c.entryId, panel: "changes" })}>
											show in transcript
										</a>
									</div>
									{!c.failed && <Diff patch={c.patch} />}
								</div>
							))}
					</div>
				);
			})}
		</div>
	);
}
