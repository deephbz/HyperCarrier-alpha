import { useEffect, useState } from "react";
import type { UiThreadView } from "../../../src/node/projection.ts";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { hub, useTopic } from "../client.ts";
import { clock, money, tokens } from "../util.ts";
import { RarebitPanel } from "./RarebitPanel.tsx";
import { TeamPanel } from "./TeamPanel.tsx";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { ShellDock } from "./ShellDock.tsx";

export const PANELS: [string, string][] = [
	["rarebit", "Rarebit"],
	["team", "Team"],
	["changes", "Changes"],
	["shell", "Shell"],
	["info", "Info"],
];

// biome-ignore lint: usage docs are loosely typed JSON
type Any = any;

/** What the agent's prompt draws from this directory: context files are listed by the transcript; skills here. */
function PromptInputs({ host, cwd }: { host: string; cwd?: string }) {
	const [found, setFound] = useState<{ prompts: Any[]; skills: Any[] }>();
	useEffect(() => {
		hub.request<{ prompts: Any[]; skills: Any[] }>(host, "prompts.list", { cwd }).then(setFound, () => setFound({ prompts: [], skills: [] }));
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

function InfoPanel({ host, threadId, summary }: { host: string; threadId: string; summary?: ThreadSummary }) {
	const { value: view } = useTopic<UiThreadView>(host, { kind: "thread", threadId });
	const agent = (view?.agent ?? {}) as Any;
	const usage = (view?.usage ?? { models: {}, tools: {} }) as Any;
	const [compactions, setCompactions] = useState<Any[]>([]);
	const compactionCount = view?.entries.filter((e) => e.kind === "compaction").length ?? 0;
	useEffect(() => {
		hub.request<{ records: Any[] }>(host, "compact.records", { threadId }).then((r) => setCompactions(r.records), () => setCompactions([]));
	}, [host, threadId, compactionCount]);
	return (
		<>
			<h3>Thread</h3>
			<dl className="kv">
				<dt>id</dt>
				<dd>{threadId}</dd>
				<dt>host</dt>
				<dd>{host}</dd>
				<dt>kind</dt>
				<dd>{summary?.kind}</dd>
				<dt>cwd</dt>
				<dd>{agent.cwd ?? summary?.cwd}</dd>
				<dt>model</dt>
				<dd>{agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "host default"}</dd>
				<dt>thinking</dt>
				<dd>{agent.thinkingLevel ?? "default"}</dd>
				<dt>context</dt>
				<dd>
					{tokens(summary?.contextTokens)} of {tokens(summary?.workingBudget ?? summary?.contextWindow)}
					{summary?.workingBudget ? ` (working budget; window ${tokens(summary.contextWindow)})` : ""}
				</dd>
				<dt>spend</dt>
				<dd>{money(summary?.costUsd ?? 0)}</dd>
			</dl>
			<PromptInputs host={host} cwd={agent.cwd ?? summary?.cwd} />
			<h3>Compactions</h3>
			{compactions.length === 0 && <div className="hint">None yet. A compaction starts when a response crosses the working budget.</div>}
			{[...compactions].reverse().map((c: Any) => (
				<div key={c.at} className="hint" style={{ marginBottom: 6 }} data-compaction={c.method}>
					{clock(c.at)} · <b>{c.method === "hc-summary" ? "HC summary" : "native fallback"}</b> ·{" "}
					{c.reason === "working_budget" ? `crossed W (${tokens(c.trigger?.tokens)} > ${tokens(c.trigger?.workingBudget)})` : c.reason} · replaced {c.replacedEntries} entries
					{c.conversationRecord ? ` · record ${c.conversationRecord.count} msgs${c.conversationRecord.omitted ? ` (+${c.conversationRecord.omitted} omitted)` : ""}` : ""}
					{c.droppedTools ? ` · ${c.droppedTools} tool results indexed` : ""}
					{c.error ? <div className="err-box">HC summary failed: {c.error}</div> : null}
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

export function Panel({ name, host, threadId, summary, setPanel }: { name: string; host: string; threadId: string; summary?: ThreadSummary; setPanel: (p?: string) => void }) {
	return (
		<aside className={`panel ${name === "shell" || name === "changes" ? "wide" : ""}`} data-panel-name={name}>
			<div className="panel-tabs">
				<div className="seg">
					{PANELS.map(([tab, label]) => (
						<button key={tab} className={tab === name ? "on" : ""} onClick={() => setPanel(tab)}>
							{label}
						</button>
					))}
				</div>
				<span style={{ flex: 1 }} />
				<button className="btn ghost small" onClick={() => setPanel(undefined)} title="Close panel">
					✕
				</button>
			</div>
			<div className={`panel-body ${name === "shell" ? "flush" : ""}`}>
				{name === "info" && <InfoPanel host={host} threadId={threadId} summary={summary} />}
				{name === "rarebit" && <RarebitPanel host={host} threadId={threadId} />}
				{name === "team" && <TeamPanel host={host} threadId={threadId} summary={summary} />}
				{name === "changes" && <ChangesPanel host={host} threadId={threadId} />}
				{name === "shell" && <ShellDock host={host} threadId={threadId} cwd={summary?.cwd} title={summary?.title} />}
			</div>
		</aside>
	);
}
