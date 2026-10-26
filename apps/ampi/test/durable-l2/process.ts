// Test-only crash carrier. A named IPC barrier selects the kill point; deadlines only bound failure.
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Event = { type: string; name?: string; value?: any };
export class CrashChild {
	readonly child: ChildProcess;
	readonly events: Event[] = [];
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	#listeners = new Set<() => void>();
	#ended = false;
	#output = "";
	constructor(dir: string, caseName: string, mode: string, fixture = new URL("./fixture.ts", import.meta.url)) {
		this.child = fork(fileURLToPath(fixture), [caseName, dir, mode], {
			execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: { ...process.env, HOME: dir, AMPI_HOME: join(dir, "ampi"), PI_CODING_AGENT_DIR: join(dir, "agent") },
		});
		for (const stream of [this.child.stdout, this.child.stderr]) stream!.on("data", (chunk) => {
			this.#output += String(chunk);
			appendFileSync(join(dir, `${mode}.log`), chunk);
		});
		this.child.on("message", (message) => {
			this.events.push(message as Event);
			appendFileSync(join(dir, "ipc.jsonl"), JSON.stringify({ mode, pid: this.child.pid, event: message }) + "\n");
			for (const notify of this.#listeners) notify();
		});
		this.exited = new Promise((resolve) => this.child.once("close", (code, signal) => {
			this.#ended = true;
			appendFileSync(join(dir, "ipc.jsonl"), JSON.stringify({ mode, pid: this.child.pid, event: { type: "exit", value: { code, signal } } }) + "\n");
			resolve({ code, signal });
			for (const notify of this.#listeners) notify();
		}));
	}
	wait(type: string, name?: string, timeoutMs = 4000): Promise<Event> {
		return new Promise((resolve, reject) => {
			const end = () => { clearTimeout(timer); this.#listeners.delete(check); };
			const check = () => {
				const event = this.events.find((e) => e.type === type && (name === undefined || e.name === name));
				// A named failure belongs to one command; an unnamed failure ends every wait.
				const failure = this.events.find((e) => e.type === "failure" && (e.name === undefined || e.name === name));
				if (failure) { end(); reject(new Error(`child failure: ${failure.value}`)); }
				else if (event) { end(); resolve(event); }
				else if (this.#ended) { end(); reject(new Error(`child ended before ${type}/${name}: ${this.#output}`)); }
			};
			const timer = setTimeout(() => { end(); reject(new Error(`IPC deadline ${type}/${name}: ${this.#output}`)); }, timeoutMs);
			this.#listeners.add(check);
			check();
		});
	}
	release(name: string): void { this.child.send({ release: name }); }
	async killAt(name: string): Promise<Event> {
		const event = await this.wait("barrier", name);
		this.child.kill("SIGKILL");
		const exit = await this.exited;
		assert.equal(exit.signal, "SIGKILL", "a real process kill must precede reopen");
		return event;
	}
	async result(): Promise<any> {
		const result = await this.wait("result");
		const exit = await this.exited;
		assert.deepEqual(exit, { code: 0, signal: null });
		return result.value;
	}
	cleanup(): void {
		if (!this.#ended) this.child.kill("SIGKILL");
	}
}
