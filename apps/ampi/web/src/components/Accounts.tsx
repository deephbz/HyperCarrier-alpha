import { useEffect, useState } from "react";
import { hub, useTopic } from "../client.ts";
import { Modal } from "./Dialogs.tsx";

// biome-ignore lint: provider and login frames are loosely typed JSON
type Any = any;

type Method = { type: "api_key" | "oauth"; label: string; subscription?: boolean };
type Provider = { id: string; name: string; signedIn: boolean; source?: string; authType?: string; methods: Method[]; models: number };

/** Ask the app to open the model-accounts dialog for a host (from banners, the checklist, or the sidebar). */
export function openAccounts(host: string): void {
	window.dispatchEvent(new CustomEvent("ampi:accounts", { detail: host }));
}

/** Tell model pickers that a host's available models changed. */
export function modelsChanged(host: string): void {
	window.dispatchEvent(new CustomEvent("ampi:models-changed", { detail: host }));
}

function LoginFlow({ host, loginId, onEnd }: { host: string; loginId: string; onEnd: (state: Any) => void }) {
	const { value } = useTopic(host, { kind: "login", loginId });
	const [answer, setAnswer] = useState("");
	const [error, setError] = useState<string>();
	useEffect(() => setAnswer(""), [value?.prompt?.id]);
	useEffect(() => {
		if (value && value.status !== "running") onEnd(value);
	}, [value?.status]);
	if (!value) return <div className="hint">Starting…</div>;
	const send = async (text: string) => {
		setError(undefined);
		try {
			await hub.request(host, "accounts.answer", { loginId, promptId: value.prompt.id, value: text });
		} catch (e) {
			setError((e as Error).message);
		}
	};
	return (
		<div className="login-flow" data-login={value.status}>
			{(value.events as Any[]).map((event, i) =>
				event.type === "auth_url" ? (
					<div key={i} className="login-step">
						<a className="btn primary small" href={event.url} target="_blank" rel="noreferrer">
							Open the sign-in page ↗
						</a>
						{event.instructions && <div className="hint">{event.instructions}</div>}
					</div>
				) : event.type === "device_code" ? (
					<div key={i} className="login-step">
						Enter <code className="device-code">{event.userCode}</code> at{" "}
						<a href={event.verificationUri} target="_blank" rel="noreferrer">
							{event.verificationUri}
						</a>
					</div>
				) : (
					<div key={i} className="hint login-step">
						{event.message}
						{(event.links ?? []).map((link: Any) => (
							<a key={link.url} href={link.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>
								{link.label ?? link.url}
							</a>
						))}
					</div>
				),
			)}
			{value.prompt && (
				<form
					className="login-step"
					onSubmit={(e) => {
						e.preventDefault();
						void send(answer);
					}}
				>
					<div>{value.prompt.message}</div>
					{value.prompt.type === "select" ? (
						<div className="login-options">
							{(value.prompt.options as Any[]).map((o) => (
								<button key={o.id} type="button" className="btn small" title={o.description} onClick={() => void send(o.id)}>
									{o.label}
								</button>
							))}
						</div>
					) : (
						<div style={{ display: "flex", gap: 6, marginTop: 6 }}>
							<input
								autoFocus
								type={value.prompt.type === "secret" ? "password" : "text"}
								autoComplete="off"
								placeholder={value.prompt.placeholder ?? (value.prompt.type === "manual_code" ? "Paste the code or the address you were sent to" : "")}
								value={answer}
								onChange={(e) => setAnswer(e.target.value)}
								style={{ flex: 1 }}
								aria-label={value.prompt.message}
							/>
							<button className="btn primary small" disabled={!answer.trim()}>
								Continue
							</button>
						</div>
					)}
				</form>
			)}
			{value.status === "running" && !value.prompt && (
				<div className="hint">
					<span className="spinner" /> Waiting for the provider…
				</div>
			)}
			{value.error && <div className="err-box">{value.error}</div>}
			{error && <div className="err-box">{error}</div>}
		</div>
	);
}

/**
 * Model accounts on one host. Sign-in runs the provider's own flow on that host's node; keys and tokens are stored in
 * pi's auth.json there and are shared with pi.
 */
/** pi-ai names an environment credential by its variable (ANTHROPIC_API_KEY); Sign out cannot remove those. */
function fromEnv(p: Provider): boolean {
	return p.signedIn && p.authType === "api_key" && /^[A-Z][A-Z0-9_]+$/.test(p.source ?? "");
}

export function AccountsDialog({ host, hostLabel, onClose }: { host: string; hostLabel: string; onClose: () => void }) {
	const [providers, setProviders] = useState<Provider[]>();
	const [error, setError] = useState<string>();
	const [filter, setFilter] = useState("");
	const [login, setLogin] = useState<{ id: string; providerId: string }>();
	const [notice, setNotice] = useState<string>();
	const load = () =>
		hub.request(host, "accounts.list").then(
			(list) => setProviders(list),
			(e) => setError((e as Error).message),
		);
	useEffect(() => {
		void load();
	}, [host]);
	const start = async (provider: Provider, method: Method) => {
		setError(undefined);
		setNotice(undefined);
		try {
			const state = await hub.request(host, "accounts.login", { providerId: provider.id, type: method.type });
			setLogin({ id: state.id, providerId: provider.id });
		} catch (e) {
			setError((e as Error).message);
		}
	};
	const close = () => {
		if (login) void hub.request(host, "accounts.cancel", { loginId: login.id }).catch(() => {});
		onClose();
	};
	const needle = filter.toLowerCase();
	const shown = (providers ?? []).filter((p) => !needle || `${p.name} ${p.id}`.toLowerCase().includes(needle));
	const signedIn = (providers ?? []).filter((p) => p.signedIn);
	return (
		<Modal onClose={close}>
			<div className="accounts" data-accounts={host}>
				<h2 style={{ marginTop: 0 }}>Models on {hostLabel}</h2>
				<p className="hint" style={{ marginTop: 0 }}>
					Sign in once per host. AmPi runs the provider's own sign-in on that host and stores the key or token in pi's{" "}
					<code>~/.pi/agent/auth.json</code> there (shared with pi, readable only by you). Keys in the node's environment, such as{" "}
					<code>ANTHROPIC_API_KEY</code>, count too.
				</p>
				{signedIn.length === 0 && providers && (
					<div className="attn-box">No model is signed in on {hostLabel} yet. Until one is, threads there use the offline simulator.</div>
				)}
				{notice && <div className="ok-box">{notice}</div>}
				{error && <div className="err-box">{error}</div>}
				{login && (
					<div className="login-box">
						<div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
							<b>Signing in to {providers?.find((p) => p.id === login.providerId)?.name}</b>
							<span style={{ flex: 1 }} />
							<button className="btn ghost small" onClick={() => void hub.request(host, "accounts.cancel", { loginId: login.id }).catch(() => {})}>
								Cancel
							</button>
						</div>
						<LoginFlow
							host={host}
							loginId={login.id}
							onEnd={(state) => {
								const name = providers?.find((p) => p.id === login.providerId)?.name;
								setLogin(undefined);
								if (state.status === "done") {
									setNotice(
										`Signed in to ${name}${state.warning ? "" : " and confirmed with a test request"}. Its models are in every model menu on ${hostLabel} now.${state.warning ? ` ${state.warning}` : ""}`,
									);
									modelsChanged(host);
								} else if (state.status === "error") setError(state.error ?? "The sign-in failed.");
								void load();
							}}
						/>
					</div>
				)}
				<input className="search" placeholder="Find a provider…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ margin: "8px 0" }} />
				<div className="provider-list">
					{!providers && !error && <div className="hint">Loading…</div>}
					{shown.map((p) => (
						<div key={p.id} className={`provider ${p.signedIn ? "on" : ""}`} data-provider={p.id}>
							<div style={{ flex: 1, minWidth: 0 }}>
								<div>
									<b>{p.name}</b> {p.signedIn && <span className="badge ok">signed in</span>}
								</div>
								<div className="hint">
									{p.signedIn ? `${fromEnv(p) ? `from $${p.source} in the node's environment` : (p.source ?? (p.authType === "oauth" ? "signed in" : "API key"))} · ` : ""}
									{p.models} model{p.models === 1 ? "" : "s"}
								</div>
							</div>
							{fromEnv(p) ? null : p.signedIn ? (
								<button
									className="btn ghost small"
									onClick={() =>
										void hub
											.request(host, "accounts.logout", { providerId: p.id })
											.then(() => (modelsChanged(host), load()))
											.catch((e) => setError((e as Error).message))
									}
								>
									Sign out
								</button>
							) : (
								p.methods.map((m) => (
									<button key={m.type} className={`btn small ${m.subscription ? "primary" : ""}`} disabled={login !== undefined} onClick={() => void start(p, m)} title={m.label}>
										{m.type === "oauth" ? (m.subscription ? "Sign in (subscription)" : "Sign in") : "Add API key"}
									</button>
								))
							)}
						</div>
					))}
				</div>
				<div className="actions">
					<button className="btn" onClick={close}>
						Done
					</button>
				</div>
			</div>
		</Modal>
	);
}
