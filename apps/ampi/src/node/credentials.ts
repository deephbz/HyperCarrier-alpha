// A CredentialStore over pi's ~/.pi/agent/auth.json, so AmPi and pi share one login per host (OAuth refreshes
// written by either are seen by both). Writes take a directory lock next to the file, compatible in spirit with
// pi's proper-lockfile lock (`auth.json.lock`), and replace the file atomically with mode 0600.

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type AuthFile = Record<string, Credential>;

export function defaultAuthPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "auth.json");
}

export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	#chain: Promise<unknown> = Promise.resolve();

	constructor(path = defaultAuthPath()) {
		this.path = path;
	}

	#read(): AuthFile {
		if (!existsSync(this.path)) return {};
		try {
			const text = readFileSync(this.path, "utf8").replace(/^﻿/, "");
			const parsed = JSON.parse(text) as unknown;
			return parsed !== null && typeof parsed === "object" ? (parsed as AuthFile) : {};
		} catch {
			return {};
		}
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.#read()[providerId];
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(this.#read()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#serial(async () => {
			options?.signal?.throwIfAborted();
			return this.#withLock(async () => {
				const data = this.#read();
				const next = await fn(data[providerId]);
				if (next === undefined) return data[providerId];
				data[providerId] = next;
				this.#write(data);
				return next;
			});
		});
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#serial(async () => {
			options?.signal?.throwIfAborted();
			await this.#withLock(async () => {
				const data = this.#read();
				delete data[providerId];
				this.#write(data);
			});
		});
	}

	#serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(task, task);
		this.#chain = run.catch(() => {});
		return run;
	}

	#write(data: AuthFile): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temp = `${this.path}.ampi-${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, this.path);
	}

	async #withLock<T>(task: () => Promise<T>): Promise<T> {
		const lock = `${this.path}.lock`;
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + 10_000;
		for (;;) {
			try {
				mkdirSync(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// A lock older than 30 s belongs to a dead writer (pi's proper-lockfile uses the same staleness idea).
				try {
					if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock);
				} catch {}
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		try {
			return await task();
		} finally {
			try {
				rmdirSync(lock);
			} catch {}
		}
	}
}
