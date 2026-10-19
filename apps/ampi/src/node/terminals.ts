// Terminals: persistent shell panes owned by the node (the Herdr pane role). A terminal outlives the hub, the window,
// and the SSH link, like a multiplexer pane; it does not outlive the node process. Output is kept as a bounded
// scrollback of numbered chunks, so a client that attaches late or reconnects gets the tail as a snapshot and new
// chunks as ordinary replication ops.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { JsonValue } from "@earendil-works/chord";
import { NodeError, expandHome } from "./runtime.ts";
import type { TopicSource } from "./server.ts";

type Pty = {
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	readonly pid: number;
};
type PtyModule = { spawn(file: string, args: string[], options: Record<string, unknown>): Pty };

const SCROLLBACK_CHARS = 400_000;
const FLUSH_MS = 16;

let ptyModule: Promise<PtyModule | undefined> | undefined;
function loadPty(): Promise<PtyModule | undefined> {
	ptyModule ??= import("node-pty").then(
		(m) => ((m as { default?: PtyModule }).default ?? (m as unknown as PtyModule)),
		() => undefined,
	);
	return ptyModule;
}

export type TerminalInfo = { id: string; title: string; cwd: string; createdAt: number; exited?: number; pid: number };

class Terminal {
	readonly info: TerminalInfo;
	readonly pty: Pty;
	chunks: { n: number; d: string }[] = [];
	#chars = 0;
	#n = 0;
	#pending = "";
	#timer?: ReturnType<typeof setTimeout>;
	readonly listeners = new Set<(value: JsonValue) => void>();
	onChange?: () => void;

	constructor(info: TerminalInfo, pty: Pty) {
		this.info = info;
		this.pty = pty;
		pty.onData((data) => {
			this.#pending += data;
			this.#timer ??= setTimeout(() => this.#flush(), FLUSH_MS);
		});
		pty.onExit(({ exitCode }) => {
			this.#flush();
			this.info.exited = exitCode;
			this.#publish();
			this.onChange?.();
		});
	}

	#flush(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.#pending) return;
		this.chunks = [...this.chunks, { n: ++this.#n, d: this.#pending }];
		this.#chars += this.#pending.length;
		this.#pending = "";
		let drop = 0;
		while (this.#chars > SCROLLBACK_CHARS && drop < this.chunks.length - 1) this.#chars -= this.chunks[drop++]!.d.length;
		if (drop) this.chunks = this.chunks.slice(drop);
		this.#publish();
	}

	value(): JsonValue {
		return { ...this.info, chunks: this.chunks } as unknown as JsonValue;
	}

	#publish(): void {
		const value = this.value();
		for (const listener of this.listeners) listener(value);
	}
}

export class Terminals {
	readonly #terms = new Map<string, Terminal>();
	readonly #listListeners = new Set<(value: JsonValue) => void>();
	#next = 1;
	// Ids never repeat across node restarts, so a client still holding an old id gets "not found", not another shell.
	readonly #boot = randomBytes(3).toString("hex");

	list(): JsonValue {
		const terms: Record<string, TerminalInfo> = {};
		for (const [id, term] of this.#terms) terms[id] = { ...term.info };
		return { terms } as unknown as JsonValue;
	}

	#changed(): void {
		const value = this.list();
		for (const listener of this.#listListeners) listener(value);
	}

	async open(args: { cwd?: string; cols?: number; rows?: number; title?: string }): Promise<TerminalInfo> {
		const pty = await loadPty();
		if (!pty) throw new NodeError("unavailable", "Terminals need the optional node-pty package on this host (npm install in apps/ampi).");
		const cwd = expandHome(args.cwd || homedir());
		const shell = process.env.SHELL || "/bin/bash";
		const proc = pty.spawn(shell, ["-l"], {
			name: "xterm-256color",
			cols: Math.max(20, Math.min(500, args.cols ?? 100)),
			rows: Math.max(5, Math.min(200, args.rows ?? 30)),
			cwd,
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", AMPI_TERMINAL: "1" },
		});
		const id = `term-${this.#boot}-${this.#next++}`;
		const term = new Terminal({ id, title: args.title || `${shell.split("/").pop()} · ${cwd.replace(homedir(), "~")}`, cwd, createdAt: Date.now(), pid: proc.pid }, proc);
		term.onChange = () => this.#changed();
		this.#terms.set(id, term);
		this.#changed();
		return { ...term.info };
	}

	#get(id: string): Terminal {
		const term = this.#terms.get(id);
		if (!term) throw new NodeError("not_found", `No terminal ${id}`);
		return term;
	}

	input(id: string, data: string): void {
		const term = this.#get(id);
		if (term.info.exited === undefined) term.pty.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		const term = this.#get(id);
		if (term.info.exited === undefined) term.pty.resize(Math.max(20, Math.min(500, cols)), Math.max(5, Math.min(200, rows)));
	}

	close(id: string): void {
		const term = this.#get(id);
		if (term.info.exited === undefined) term.pty.kill();
		this.#terms.delete(id);
		this.#changed();
	}

	listSource(): TopicSource {
		const self = this;
		return {
			get value() {
				return self.list();
			},
			subscribe: (listener) => {
				this.#listListeners.add(listener);
				return () => this.#listListeners.delete(listener);
			},
		};
	}

	source(id: string): TopicSource {
		const term = this.#get(id);
		return {
			get value() {
				return term.value();
			},
			subscribe(listener) {
				term.listeners.add(listener);
				return () => term.listeners.delete(listener);
			},
		};
	}

	closeAll(): void {
		for (const term of this.#terms.values()) if (term.info.exited === undefined) term.pty.kill();
		this.#terms.clear();
	}
}

