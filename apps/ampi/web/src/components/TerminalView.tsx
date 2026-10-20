import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { hub, useTopic } from "../client.ts";
import { effectiveTheme, useTheme, type Theme } from "../theme.ts";
import { go, goTerm } from "../util.ts";

// biome-ignore lint: terminal frames are loosely typed JSON
type Any = any;

const TERM_THEME: Record<Theme, Terminal["options"]["theme"]> = {
	dark: { background: "#16181d", foreground: "#e5e7eb" },
	light: { background: "#fbfbfa", foreground: "#1f2328", cursor: "#1f2328", selectionBackground: "#c7d2fe" },
};

/**
 * A node-owned shell pane (the Herdr pane role). The shell keeps running when this view, the window, or the SSH link
 * goes away; reopening it replays the retained scrollback.
 */
export function TerminalView({ host, termId, docked }: { host: string; termId: string; docked?: { onClosed: () => void } }) {
	const { value, stale, error } = useTopic(host, { kind: "term", termId });
	const box = useRef<HTMLDivElement>(null);
	const term = useRef<Terminal>(undefined);
	const written = useRef(0);
	useEffect(() => {
		const zoom = Number((JSON.parse(localStorage.getItem("ampi.display") ?? "{}") as { overall?: number }).overall ?? 1);
		const t = new Terminal({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: Math.round(13 * zoom),
			cursorBlink: true,
			scrollback: 20_000,
			theme: TERM_THEME[effectiveTheme()],
		});
		const fit = new FitAddon();
		t.loadAddon(fit);
		t.open(box.current!);
		term.current = t;
		written.current = 0;
		const input = t.onData((data) => void hub.request(host, "term.input", { termId, data }).catch(() => {}));
		const display = () => {
			const scale = Number((JSON.parse(localStorage.getItem("ampi.display") ?? "{}") as { overall?: number }).overall ?? 1);
			t.options.fontSize = Math.round(13 * scale);
		};
		window.addEventListener("ampi:display", display);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const resize = () => {
			fit.fit();
			clearTimeout(timer);
			timer = setTimeout(() => void hub.request(host, "term.resize", { termId, cols: t.cols, rows: t.rows }).catch(() => {}), 80);
		};
		const observer = new ResizeObserver(resize);
		observer.observe(box.current!);
		resize();
		t.focus();
		return () => {
			observer.disconnect();
			input.dispose();
			window.removeEventListener("ampi:display", display);
			t.dispose();
			term.current = undefined;
		};
	}, [host, termId]);
	const theme = useTheme();
	useEffect(() => {
		if (term.current) term.current.options.theme = TERM_THEME[theme];
	}, [theme]);
	useEffect(() => {
		const t = term.current;
		if (!t || !value) return;
		const chunks = value.chunks as { n: number; d: string }[];
		// A snapshot that no longer contains what we wrote (reconnect, trimmed scrollback): redraw from it.
		if (chunks.length && (chunks[0]!.n > written.current + 1 || chunks.at(-1)!.n < written.current)) {
			t.reset();
			written.current = 0;
		}
		for (const chunk of chunks) {
			if (chunk.n <= written.current) continue;
			t.write(chunk.d);
			written.current = chunk.n;
		}
	}, [value]);
	if (docked)
		return (
			<div className="term-dock">
				<div className="term-dock-head">
					<span className="hint">
						{value?.title ?? termId}
						{value?.exited !== undefined ? ` · exited (${value.exited})` : ""}
					</span>
					<span className="grow" />
					{(stale || error) && <span className="badge err">{error ?? "reconnecting…"}</span>}
					<button className="btn ghost small" title="Show this shell full size" onClick={() => goTerm(host, termId)}>
						⤢
					</button>
					<button
						className="btn ghost small"
						title="End this shell"
						onClick={() => {
							void hub.request(host, "term.close", { termId }).catch(() => {});
							docked.onClosed();
						}}
					>
						End
					</button>
				</div>
				<div className="term-box" ref={box} data-term={termId} />
			</div>
		);
	return (
		<div className="main">
			<div className="topbar">
				<b>{value?.title ?? termId}</b>
				<span className="crumbs">
					terminal on {host}
					{value?.exited !== undefined ? ` · exited (${value.exited})` : ""}
				</span>
				<span className="spacer" />
				{(stale || error) && <span className="badge err">{error ?? "reconnecting…"}</span>}
				<button
					className="btn ghost small"
					onClick={() => {
						void hub.request(host, "term.close", { termId }).catch(() => {});
						go();
					}}
				>
					Close terminal
				</button>
			</div>
			<div className="term-box" ref={box} data-term={termId} />
		</div>
	);
}
