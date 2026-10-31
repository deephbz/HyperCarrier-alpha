import { useEffect, useState, type ReactNode } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import { money } from "../util.ts";
import { useHoverCard } from "./hover-card.tsx";

export function SessionTitle({ children, title, summary, host, parent }: { children: ReactNode; title: string; summary?: ThreadSummary; host: string; parent?: ReactNode }) {
	const { id, open, setOpen, anchorProps, render } = useHoverCard<HTMLDivElement>();
	const [copied, setCopied] = useState<"ok" | "error">();
	useEffect(() => { setCopied(undefined); setOpen(false); }, [summary?.id, host]);
	const date = (value?: number) => value === undefined ? "Unknown" : new Date(value).toLocaleString(undefined, { hour12: false });
	const location = summary?.location;
	const rows = [
		["Title", title], ["Directory", summary?.cwd || "Unknown"], ["Cost", summary?.updating ? "Updating" : summary ? summary.spendLabel ?? money(summary.costUsd) : "Unknown"],
		["Workspace", location?.workspaceLabel || location?.workspace || "Unknown"],
		["Tab", location?.tabLabel || location?.tab || "Unknown"], ["Pane", location?.pane || "Unknown"],
		["Kind", summary?.kind || "Unknown"], ["Team", summary?.team?.teamId],
		["Role", summary?.team ? [summary.team.role, summary.team.worker].filter(Boolean).join(" · ") : undefined],
		["Host", host], ["Session", summary?.id || "Unknown"], ["Reference", summary?.ref || "Unknown"],
		["Model", summary?.model || "Unknown"], ["Started", date(summary?.createdAt)], ["Updated", date(summary?.updatedAt)],
		["Live", summary?.live === undefined ? "Unknown" : summary.live ? "Running" : "Not running"],
		["Control", summary?.control ? "Control extension" : summary?.live ? "typed into Herdr pane" : "Not running"],
	].filter((row): row is [string, string] => Boolean(row[1]));
	const copy = async () => {
		try { await navigator.clipboard.writeText(rows.map(([key, value]) => `${key}: ${value}`).join("\n")); setCopied("ok"); }
		catch { setCopied("error"); }
	};
	return <div className="session-title" {...anchorProps}>
		<div className="session-title-line" aria-describedby={open ? id : undefined}>{children}
			<button className="btn ghost small session-copy" aria-label={copied === "ok" ? "Metadata copied" : copied === "error" ? "Copy failed: retry metadata copy" : "Copy Session metadata"} title={copied === "ok" ? "Copied" : copied === "error" ? "Copy failed: retry" : "Copy Session metadata"} onClick={() => void copy()}>
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">{copied === "ok" ? <path d="m3 8 3 3 7-7" /> : copied === "error" ? <path d="m4 4 8 8m0-8-8 8" /> : <><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M3 10H2V2h8v1" /></>}</svg>
			</button>
		</div>
		{render("Session metadata", <><dl>{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>{parent}</>)}
	</div>;
}
