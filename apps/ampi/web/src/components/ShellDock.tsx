import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { hub, useTopic } from "../client.ts";
// xterm is most of the bundle; it loads the first time a terminal is shown.
const TerminalView = lazy(() => import("./TerminalView.tsx").then((m) => ({ default: m.TerminalView })));

// biome-ignore lint: the terminal list is loosely typed JSON
type Any = any;

const keyOf = (host: string, threadId: string) => `ampi.shell.${host}|${threadId}`;

/**
 * The thread's own shell, docked beside its transcript (the Herdr split): opening the tab starts a node-owned shell
 * in the thread's directory once, and the same shell comes back whenever the thread is shown again.
 */
export function ShellDock({ host, threadId, cwd, title }: { host: string; threadId: string; cwd?: string; title?: string }) {
	const { value: list } = useTopic(host, { kind: "terms" });
	const [termId, setTermId] = useState<string | undefined>(() => localStorage.getItem(keyOf(host, threadId)) ?? undefined);
	const [ended, setEnded] = useState(false);
	const [error, setError] = useState<string>();
	const starting = useRef(false);
	const known = termId !== undefined && list?.terms?.[termId] !== undefined;
	const start = async () => {
		if (starting.current) return;
		starting.current = true;
		setError(undefined);
		try {
			// Named for its thread, so the host's terminal list says whose shell it is.
			const term = await hub.request(host, "term.open", { cwd, cols: 80, rows: 30, title: `shell · ${title ?? "thread"}`.slice(0, 60) });
			localStorage.setItem(keyOf(host, threadId), term.id);
			setTermId(term.id);
			setEnded(false);
		} catch (e) {
			setError((e as Error).message);
		}
		starting.current = false;
	};
	useEffect(() => {
		// A shell from before a node restart is gone; start a fresh one unless the owner just ended it.
		if (list && !known && !ended && !error) void start();
	}, [list, known, ended, error]);
	if (known)
		return (
			<Suspense fallback={<div className="empty">Loading the terminal…</div>}>
			<TerminalView
				key={termId}
				host={host}
				termId={termId!}
				docked={{
					onClosed: () => {
						localStorage.removeItem(keyOf(host, threadId));
						setTermId(undefined);
						setEnded(true);
					},
				}}
			/>
			</Suspense>
		);
	return (
		<div className="empty" style={{ padding: 20 }}>
			{error ? <div className="err-box">{error}</div> : ended ? "The shell ended." : "Starting a shell…"}
			{(ended || error) && (
				<div style={{ marginTop: 10 }}>
					<button className="btn small" onClick={() => void start()}>
						Start a shell in {cwd ?? "the home directory"}
					</button>
				</div>
			)}
		</div>
	);
}
