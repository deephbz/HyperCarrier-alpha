// Model accounts for one node: which providers are signed in, and sign-in flows the GUI can drive. Every flow is the
// provider's own pi-ai login (API key or OAuth); the node runs it, the GUI answers its prompts and shows its links and
// device codes. Credentials land in pi's auth.json on this host (0600), shared with pi, and never travel back out.

import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { AuthEvent, AuthPrompt, AuthType, Credential, MutableModels } from "@earendil-works/pi-ai";
import { credentialsOf } from "./models.ts";
import { NodeError } from "./runtime.ts";
import type { TopicSource } from "./server.ts";
import { SIM_PROVIDER } from "./sim.ts";

export type ProviderStatus = {
	id: string;
	name: string;
	signedIn: boolean;
	/** Where the working credential comes from (stored key, OAuth, an environment variable), when signed in. */
	source?: string;
	authType?: "api_key" | "oauth";
	methods: { type: AuthType; label: string; subscription?: boolean }[];
	models: number;
};

type PromptView = { id: string; type: AuthPrompt["type"]; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };

export type LoginState = {
	id: string;
	providerId: string;
	type: AuthType;
	status: "running" | "done" | "error" | "cancelled";
	events: AuthEvent[];
	prompt?: PromptView;
	error?: string;
	/** Set when the credential was saved but the provider could not be reached to confirm it. */
	warning?: string;
};

// Only a definite credential rejection counts. A 403 can mean a model outside the plan or a region block, which says
// nothing about the credential, so it is reported as unconfirmed rather than undone.
const AUTH_FAILURE = /\b401\b|unauthori[sz]ed|authentication_error|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|invalid_grant/i;

/** Same stored secret: a later sign-in for this provider has not replaced it. */
function sameCredential(a: Credential | undefined, b: Credential): boolean {
	return a?.type === b.type && (a.type === "api_key" ? a.key === (b as typeof a).key : a.access === (b as typeof a).access);
}

/** One summarized error message: providers often return a JSON body. */
export function shortError(text: string): string {
	const message = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1];
	const status = /\b(4\d\d|5\d\d)\b/.exec(text)?.[1];
	return `${message ?? text.split("\n")[0]!.slice(0, 160)}${status && message ? ` (${status})` : ""}`;
}

/**
 * Confirm a provider's credential with the smallest request its cheapest model accepts. `ok: false` when the
 * provider rejects the credential; `ok: undefined` when it cannot be reached (offline, timeout), which proves nothing.
 */
export async function verifyProvider(models: MutableModels, providerId: string): Promise<{ ok: boolean | undefined; reason?: string }> {
	const provider = models.getProviders().find((p) => p.id === providerId);
	const candidates = [...(provider?.getModels() ?? [])].sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0));
	const model = candidates[0];
	if (!model) return { ok: undefined, reason: "the provider lists no models yet." };
	try {
		const reply = await models.complete(model, { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] }, { maxTokens: 16, signal: AbortSignal.timeout(20_000) });
		if (reply.stopReason !== "error") return { ok: true };
		const reason = shortError(reply.errorMessage ?? "unknown error");
		return AUTH_FAILURE.test(reply.errorMessage ?? "") ? { ok: false, reason } : { ok: undefined, reason };
	} catch (error) {
		const text = (error as Error).message;
		return AUTH_FAILURE.test(text) ? { ok: false, reason: shortError(text) } : { ok: undefined, reason: shortError(text) };
	}
}

class Login {
	state: LoginState;
	readonly controller = new AbortController();
	readonly listeners = new Set<(value: JsonValue) => void>();
	#answer?: { id: string; resolve: (value: string) => void; reject: (error: Error) => void };

	constructor(providerId: string, type: AuthType) {
		this.state = { id: randomUUID(), providerId, type, status: "running", events: [] };
	}

	update(change: Partial<LoginState>): void {
		const next: Record<string, unknown> = { ...this.state, ...change };
		// Replicated values are JSON: drop cleared fields instead of keeping them as undefined.
		for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
		this.state = next as LoginState;
		const value = this.state as unknown as JsonValue;
		for (const listener of this.listeners) listener(value);
	}

	ask(prompt: AuthPrompt): Promise<string> {
		const id = randomUUID();
		const { signal, ...rest } = prompt;
		this.update({ prompt: { id, ...(rest as Omit<PromptView, "id">) } });
		return new Promise<string>((resolve, reject) => {
			this.#answer = { id, resolve, reject };
			const abort = () => {
				if (this.#answer?.id !== id) return;
				this.#answer = undefined;
				if (this.state.prompt?.id === id) this.update({ prompt: undefined });
				reject(new Error("prompt cancelled"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			this.controller.signal.addEventListener("abort", abort, { once: true });
		});
	}

	answer(promptId: string, value: string): void {
		if (!this.#answer || this.#answer.id !== promptId) throw new NodeError("conflict", "That question is no longer open");
		const { resolve } = this.#answer;
		this.#answer = undefined;
		this.update({ prompt: undefined });
		resolve(value);
	}
}

export class Accounts {
	readonly #models: MutableModels;
	readonly #logins = new Map<string, Login>();

	constructor(models: MutableModels) {
		this.#models = models;
	}

	async providers(): Promise<ProviderStatus[]> {
		const out: ProviderStatus[] = [];
		for (const provider of this.#models.getProviders()) {
			if (provider.id === SIM_PROVIDER) continue;
			const methods: ProviderStatus["methods"] = [];
			if (provider.auth.oauth) methods.push({ type: "oauth", label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name, ...(provider.auth.oauth.isSubscription ? { subscription: true } : {}) });
			if (provider.auth.apiKey?.login) methods.push({ type: "api_key", label: provider.auth.apiKey.name });
			let check: { source?: string; type: "api_key" | "oauth" } | undefined;
			try {
				check = await this.#models.checkAuth(provider.id);
			} catch {}
			out.push({
				id: provider.id,
				name: provider.name,
				signedIn: check !== undefined,
				...(check?.source ? { source: check.source } : {}),
				...(check ? { authType: check.type } : {}),
				methods,
				models: provider.getModels().length,
			});
		}
		// Signed-in first, then subscriptions and the common providers, then the rest by name.
		const rank = (p: ProviderStatus) => (p.signedIn ? 0 : p.methods.some((m) => m.subscription) ? 1 : ["anthropic", "openai", "google", "openrouter"].includes(p.id) ? 2 : 3);
		return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	}

	start(providerId: string, type: AuthType): LoginState {
		const provider = this.#models.getProviders().find((p) => p.id === providerId);
		if (!provider || providerId === SIM_PROVIDER) throw new NodeError("not_found", `No provider ${providerId}`);
		if (type === "oauth" ? !provider.auth.oauth : !provider.auth.apiKey?.login) throw new NodeError("bad_request", `${provider.name} has no ${type === "oauth" ? "sign-in" : "API key"} flow`);
		for (const other of this.#logins.values()) if (other.state.status === "running") other.controller.abort();
		const login = new Login(providerId, type);
		this.#logins.set(login.state.id, login);
		const interaction = {
			signal: login.controller.signal,
			prompt: (prompt: AuthPrompt) => login.ask(prompt),
			notify: (event: AuthEvent) => login.update({ events: [...login.state.events, event].slice(-20) }),
		};
		const store = credentialsOf(this.#models);
		void (async () => {
			// pi-ai writes the new credential over the old one before anyone can check it, so keep the old one to put back.
			const previous = await store?.read(providerId).catch(() => undefined);
			let credential: Credential;
			try {
				credential = await this.#models.login(providerId, type, interaction);
			} catch (error) {
				const aborted = login.controller.signal.aborted;
				return login.update({ status: aborted ? "cancelled" : "error", prompt: undefined, ...(aborted ? {} : { error: (error as Error).message }) });
			}
			// A stored credential is not a working one: ask the provider once before saying "signed in".
			login.update({ prompt: undefined, events: [...login.state.events, { type: "progress", message: "Checking the sign-in with the provider…" }] });
			const check = await verifyProvider(this.#models, providerId);
			if (check.ok !== false) return login.update({ status: "done", ...(check.ok === undefined ? { warning: `Saved, but not confirmed: ${check.reason}` } : {}) });
			// Undo only this flow's write: a sign-in that finished since then owns the entry now.
			const kept = previous ? "Your previous sign-in is kept" : "Nothing was saved";
			try {
				if (!store) await this.#models.logout(providerId);
				else if (previous) await store.modify(providerId, async (current) => (sameCredential(current, credential) ? previous : undefined));
				else if (sameCredential(await store.read(providerId), credential)) await store.delete(providerId);
			} catch (error) {
				return login.update({ status: "error", error: `${provider.name} did not accept this sign-in (${check.reason}), and removing it failed: ${(error as Error).message}` });
			}
			login.update({ status: "error", error: `${provider.name} did not accept this sign-in: ${check.reason}. ${kept}; try again.` });
		})();
		// Finished flows are kept briefly so a reconnecting GUI still sees how they ended.
		if (this.#logins.size > 20) this.#logins.delete(this.#logins.keys().next().value!);
		return login.state;
	}

	#get(id: string): Login {
		const login = this.#logins.get(id);
		if (!login) throw new NodeError("not_found", "That sign-in has ended");
		return login;
	}

	answer(id: string, promptId: string, value: string): void {
		this.#get(id).answer(promptId, value);
	}

	cancel(id: string): void {
		const login = this.#get(id);
		if (login.state.status === "running") login.controller.abort();
	}

	async logout(providerId: string): Promise<void> {
		await this.#models.logout(providerId);
	}

	source(id: string): TopicSource {
		const login = this.#get(id);
		return {
			get value() {
				return login.state as unknown as JsonValue;
			},
			subscribe(listener) {
				login.listeners.add(listener);
				return () => login.listeners.delete(listener);
			},
		};
	}
}
