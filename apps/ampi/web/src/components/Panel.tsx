import { useEffect, useState } from "react";
import { fallbackRun, recordLine } from "../../../src/shared/compact-record.ts";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { hub, useHosts, useTopic } from "../client.ts";
import { hostLabelFor } from "./host-label.ts";
import { clock, money, tokens } from "../util.ts";

// biome-ignore lint: usage docs are loosely typed JSON
type Any = any;

/** What the agent's prompt draws from this directory: context files are listed by the transcript; skills here. */
function PromptInputs({ host, cwd }: { host: string; cwd?: string }) {
	const [found, setFound] = useState<{ prompts: Any[]; skills: Any[] }>();
	useEffect(() => {
		hub.request(host, "prompts.list", { cwd }).then(setFound, () => setFound({ prompts: [], skills: [] }));
	}, [host, cwd]);
	if (!found) return null;
	return (
		<>
			<h3>Skills in the agent's prompt · {found.skills.length}</h3>
			{found.skills.length === 0 && <div className="hint">None. Skills come from .pi/skills and .agents/skills within the repository, and ~/.pi/agent/skills.</div>}
			{found.skills.map((k) => (
				<div key={k.name} className="hint" style={{ marginBottom: 4 }} title={k.path}>
					<b>{k.name}</b> · {k.description}
				</div>
			))}
			<h3>Prompt templates · {found.prompts.length}</h3>
			{found.prompts.length === 0 ? <div className="hint">None.</div> : <div className="hint">{found.prompts.map((p) => `/${p.name}`).join("  ")}</div>}
		</>
	);
}

/** A durable thread's Info panel: its model, usage, and the prompt inputs of its directory. */
export function InfoPanel({ host, threadId, summary }: { host: string; threadId: string; summary?: ThreadSummary }) {
	const { value: view } = useTopic(host, { kind: "thread", threadId });
	const { hosts } = useHosts();
	const agent = (view?.agent ?? {}) as Any;
	const usage = (view?.usage ?? { models: {}, tools: {} }) as Any;
	const [compactions, setCompactions] = useState<Any[]>([]);
	const compactionCount = view?.entries.filter((e) => e.kind === "compaction").length ?? 0;
	useEffect(() => {
		hub.request(host, "compact.records", { threadId }).then((r) => setCompactions(r.records), () => setCompactions([]));
	}, [host, threadId, compactionCount]);
	return (
		<>
			<h3>Thread</h3>
			<dl className="kv">
				<dt>id</dt>
				<dd>{threadId}</dd>
				<dt>host</dt>
				<dd>{hostLabelFor(host, hosts)}</dd>
				<dt>kind</dt>
				<dd>{summary?.kind}</dd>
				<dt>cwd</dt>
				<dd>{agent.cwd ?? summary?.cwd}</dd>
				<dt>model</dt>
				<dd>{agent.model ?? summary?.model ?? "host default"}</dd>
				<dt>thinking</dt>
				<dd>{agent.thinkingLevel ?? "default"}</dd>
				<dt>context</dt>
				<dd>
					{tokens(summary?.contextTokens)} of {tokens(summary?.workingBudget ?? summary?.contextWindow)}
					{summary?.workingBudget ? ` (working budget; window ${tokens(summary.contextWindow)})` : ""}
				</dd>
				<dt>spend</dt>
				<dd>{summary?.spendLabel ?? money(summary?.costUsd ?? 0)}</dd>
			</dl>
			<PromptInputs host={host} cwd={agent.cwd ?? summary?.cwd} />
			<h3>Compactions</h3>
			{compactions.length === 0 && <div className="hint">None yet. A compaction starts when a response crosses the working budget.</div>}
			{fallbackRun(compactions) >= 2 && <div className="err-box">Planner failing; summary only: {fallbackRun(compactions)} fallbacks in a row.</div>}
			{[...compactions].reverse().map((c: Any) => (
				<div key={c.at} className="hint" style={{ marginBottom: 6 }} data-compaction={c.method}>
					{clock(c.at)} · {c.reason === "working_budget" ? `crossed W (${tokens(c.trigger?.tokens)} > ${tokens(c.trigger?.workingBudget)})` : c.reason} · <b>{recordLine(c)}</b>
					{c.conversationRecord ? ` · record ${c.conversationRecord.count} msgs${c.conversationRecord.omitted ? ` (+${c.conversationRecord.omitted} omitted)` : ""}` : ""}
					{c.method === "hc-summary" && c.droppedTools ? ` · ${c.droppedTools} tool results indexed` : ""}
				</div>
			))}
			<h3>Usage by model</h3>
			{Object.keys(usage.models ?? {}).length === 0 && <div className="hint">No model calls yet.</div>}
			{Object.entries(usage.models ?? {}).map(([key, u]: [string, Any]) => (
				<dl className="kv" key={key} style={{ marginBottom: 8 }}>
					<dt>model</dt>
					<dd>{key}</dd>
					<dt>input</dt>
					<dd>{tokens(u.input)}</dd>
					<dt>cache read</dt>
					<dd>{tokens(u.cacheRead)}</dd>
					<dt>cache write</dt>
					<dd>{tokens(u.cacheWrite)}</dd>
					<dt>output</dt>
					<dd>{tokens(u.output)}</dd>
					<dt>cost</dt>
					<dd>{money(u.cost?.total ?? 0)}</dd>
				</dl>
			))}
		</>
	);
}
