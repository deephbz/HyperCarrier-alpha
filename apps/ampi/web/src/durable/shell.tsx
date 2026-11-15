// The durable node's parts of the App shell (shell-slots.ts), registered in extensions-ui.ts: its sidebar notes and
// Archived group, the Show archived toggle, the first-run checklist, the settings notices and the Accounts dialog.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { SettingsNotice, ThreadSummary } from "../../../src/shared/protocol.ts";
import { type HostState, hub } from "../client.ts";
import { displayCwd } from "../hud.ts";
import { hasRealModel, useModels } from "../models.ts";
import { MOD, go } from "../util.ts";
import { AccountsDialog, openAccounts } from "../components/Accounts.tsx";
import { hostLabel, hostLabelFor, isPiHost } from "../components/host-label.ts";
import type { HostThreads } from "../components/Sidebar.tsx";
import type { AppLayerProps, HelpActionProps, HostKindUi, OverviewStepProps, SidebarFooterProps } from "../shell-slots.ts";
import { tabPane } from "./kind.ts";
import { DurableNewForm } from "./new-form.tsx";

/**
 * A durable node's own notes: signed-in models, the offline simulator, and a node on another AmPi build.
 * A Pi Host has no node, so it shows none of them.
 */
export function NodeNotes({ host }: { host: HostState }) {
	const real = hasRealModel(useModels(host.link, host.status === "connected"));
	if (host.status !== "connected") return null;
	return (
		<>
			{real === false ? (
				<div className="host-note warn" data-no-model={host.id}>
					No model is signed in here, so threads use the offline simulator.{" "}
					<a
						href="#"
						onClick={(e) => {
							e.preventDefault();
							openAccounts(host.link);
						}}
					>
						Set up models
					</a>
				</div>
			) : null}
			{host.buildMismatch && (
				<div className="host-note warn" data-build-mismatch={host.id}>
					This node needs the new build ({host.node?.build ?? "unknown"}).{" "}
					<a
						href="#"
						onClick={(e) => {
							e.preventDefault();
							void hub.request(host.link, "node.restart").catch((error) => alert((error as Error).message));
						}}
					>
						Restart it
					</a>{" "}
					— running work resumes.
				</div>
			)}
		</>
	);
}

// Show archived: one page-wide choice that the footer toggles and every durable section reads.
let showArchived = false;
const archivedListeners = new Set<() => void>();
function setShowArchived(next: boolean) {
	showArchived = next;
	for (const listener of archivedListeners) listener();
}
function useShowArchived(): boolean {
	return useSyncExternalStore(
		(listener) => {
			archivedListeners.add(listener);
			return () => archivedListeners.delete(listener);
		},
		() => showArchived,
		() => showArchived,
	);
}

function useUnarchivedRows(threads: ThreadSummary[]): ThreadSummary[] {
	const show = useShowArchived();
	return show ? threads : threads.filter((t) => !t.archived);
}

export function ShowArchived({ data }: SidebarFooterProps) {
	const show = useShowArchived();
	const count = data.reduce((total, host) => total + host.threads.filter((thread) => thread.archived).length, 0);
	return (
		<button className="btn ghost small" onClick={() => setShowArchived(!show)}>
			{show ? "Hide archived" : `Show archived (${count})`}
		</button>
	);
}

export const ONBOARDING_KEY = "ampi.onboarding.dismissed";

function Step({ done, title, children, action }: { done: boolean | undefined; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
	return (
		<div className={`step ${done ? "done" : ""}`} data-step={title} data-done={done ? "yes" : "no"}>
			<span className="check">{done ? "✓" : ""}</span>
			<div className="what">
				<b>{title}</b>
				{children && <div className="hint">{children}</div>}
			</div>
			{!done && action}
		</div>
	);
}

/**
 * First-run checklist, computed from real state rather than ticked by hand: the local node answers, a real model is
 * signed in, a thread exists, a remote host is added. It stays until every required step is done or the owner hides it.
 * Pi Hosts (D15 stage 1) start agents in Herdr and have no node to set up, so a hub of Pi Hosts only shows none.
 */
export function Onboarding({ data, onNew, onHostSetup, onHelp }: OverviewStepProps) {
	const [hidden, setHidden] = useState(() => localStorage.getItem(ONBOARDING_KEY) === "1");
	const local = data.find((d) => d.host.kind === "local") ?? data[0];
	const connected = local?.host.status === "connected";
	const real = hasRealModel(useModels(local?.host.link, connected));
	const piOnly = data.length > 0 && data.every((d) => isPiHost(d.host));
	const anyThread = data.some((d) => d.threads.some((t) => t.kind === "thread"));
	const remote = data.find((d) => d.host.kind === "ssh" || d.host.kind === "pi-ssh");
	const required = connected && real === true && anyThread;
	if (piOnly || hidden || required) return null;
	return (
		<div className="onboarding" data-onboarding>
			<div style={{ display: "flex", alignItems: "baseline" }}>
				<h2>Set up AmPi</h2>
				<span style={{ flex: 1 }} />
				<button
					className="btn ghost small"
					onClick={() => {
						localStorage.setItem(ONBOARDING_KEY, "1");
						setHidden(true);
					}}
				>
					Hide
				</button>
			</div>
			<div className="hint" style={{ marginBottom: 6 }}>
				Three steps, about two minutes. Each turns green on its own. <a href="#" onClick={(e) => (e.preventDefault(), onHelp())}>Keys and help (?)</a>
			</div>
			<Step done={connected} title="This computer's node is running">
				{connected
					? `${local!.host.node?.hostname ?? "local"} · agents keep working when this window closes.`
					: "The hub is starting its local node. If this stays, run ampi doctor in a terminal."}
			</Step>
			<Step
				done={real}
				title="Sign in to a model"
				action={
					connected && (
						<button className="btn primary small" onClick={() => openAccounts(local!.host.link)}>
							Set up models
						</button>
					)
				}
			>
				{real
					? "A model is signed in on this computer."
					: "Use a subscription (Claude, ChatGPT) or an API key. Until then, threads run on the offline simulator, which only demonstrates the interface."}
			</Step>
			<Step
				done={anyThread}
				title="Start a thread"
				action={
					<button className="btn small" onClick={onNew}>
						New agent <span className="kbd">{MOD}N</span>
					</button>
				}
			>
				Pick a folder and say what you want done. The thread keeps running if you close this window.
			</Step>
			<Step
				done={remote !== undefined}
				title="Optional: add a remote machine over SSH"
				action={
					<button className="btn small" onClick={onHostSetup}>
						Remote host (?)
					</button>
				}
			>
				{remote
					? `${hostLabel(remote.host, data.map((d) => d.host))} is added.`
					: "Copy the setup prompt into a coding agent; it sets up SSH and the machine, then adds the Host to hub.json."}
			</Step>
		</div>
	);
}

/** Help's way back to the checklist after the owner hid it. */
export function ShowChecklist({ onClose }: HelpActionProps) {
	return (
		<button
			className="btn"
			onClick={() => {
				localStorage.removeItem(ONBOARDING_KEY);
				onClose();
				go();
			}}
		>
			Show the setup checklist
		</button>
	);
}

const NOTICED = "ampi.settingsNotice";

/**
 * Invalid Pi settings a Host ignored, as Pi's Auto Compact warns about them: one notice per Host and settings stamp,
 * also across reloads. It stays until the owner dismisses it; an edit that fixes the file ends it.
 */
export function SettingsNotices({ feeds }: AppLayerProps) {
	const [open, setOpen] = useState<({ host: string; link: string; label: string } & SettingsNotice)[]>([]);
	useEffect(() => {
		const noticed = JSON.parse(localStorage.getItem(NOTICED) ?? "{}") as Record<string, string>;
		const fresh = Object.values(feeds).flatMap(({ host, settingsNotice: n }: HostThreads) => (n && noticed[host.id] !== n.stamp ? [{ host: host.id, link: host.link, label: host.label, ...n }] : []));
		for (const n of fresh) noticed[n.host] = n.stamp;
		if (fresh.length) localStorage.setItem(NOTICED, JSON.stringify(noticed));
		setOpen((prev) => {
			// A reconnecting Host keeps its notice; a Host that reports another stamp or none ends it.
			const next = [...prev.filter((n) => { const f = feeds[n.link]; return !f || f.stale || f.settingsNotice?.stamp === n.stamp; }), ...fresh];
			return next.length === prev.length && next.every((n, i) => n === prev[i]) ? prev : next;
		});
	}, [feeds]);
	if (!open.length) return null;
	return (
		<div className="toast settings-notice" role="status" aria-live="polite">
			{open.map((n) => (
				<p key={n.link}>
					{n.label}: ignored invalid Pi settings in {displayCwd(n.file)}: {n.errors.join("; ")}.{" "}
					<button className="link-button" onClick={() => setOpen((prev) => prev.filter((o) => o !== n))}>Dismiss</button>
				</p>
			))}
		</div>
	);
}

/** The Accounts dialog, opened by openAccounts from any view. */
export function AccountsLayer({ hosts }: AppLayerProps) {
	const [accounts, setAccounts] = useState<string>();
	useEffect(() => {
		const open = (e: Event) => setAccounts((e as CustomEvent).detail as string);
		window.addEventListener("ampi:accounts", open);
		return () => window.removeEventListener("ampi:accounts", open);
	}, []);
	return accounts ? <AccountsDialog host={accounts} hostLabel={hostLabelFor(accounts, hosts)} onClose={() => setAccounts(undefined)} /> : null;
}

export const durableUi: HostKindUi = {
	sidebar: {
		Notes: NodeNotes,
		useRows: useUnarchivedRows,
		paneOf: tabPane,
		unplacedLabel: "Archived",
		readingNote: "Reading threads…",
		emptyNote: "No threads yet. Start a thread to begin.",
	},
	NewForm: DurableNewForm,
};
