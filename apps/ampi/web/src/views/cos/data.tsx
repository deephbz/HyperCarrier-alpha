import { useCallback, useEffect, useMemo, useState } from "react";
import { useHosts, useTopic, type HostState } from "../../client.ts";

export type ViewError = { error: { code: string; message: string } };
type Feed<T> = { host: HostState; value?: T; stale: boolean; error?: string };
function HostValue<T>({ host, view, onValue }: { host: HostState; view: string; onValue: (id: string, value: Omit<Feed<T>, "host">) => void }) {
	const feed = useTopic<T | ViewError>(host.id, { kind: "view", view });
	useEffect(() => {
		const failed = feed.value && typeof feed.value === "object" && "error" in feed.value ? feed.value as ViewError : undefined;
		onValue(host.id, failed ? { stale: feed.stale, error: `${failed.error.message}. Reconnect the Host to retry.` } : feed as Omit<Feed<T>, "host">);
	}, [host.id, feed.value, feed.stale, feed.error, onValue]);
	return null;
}

/** A child subscription per Host: hook order does not depend on fleet size. */
export function useFleet<T>(view: string) {
	const { hosts, connected } = useHosts();
	const [values, setValues] = useState<Record<string, Omit<Feed<T>, "host">>>({});
	const update = useCallback((id: string, feed: Omit<Feed<T>, "host">) => setValues((old) => ({ ...old, [id]: feed })), []);
	const pi = useMemo(() => hosts.filter((h) => h.kind === "pi-local" || h.kind === "pi-ssh"), [hosts]);
	const feeds = useMemo(() => pi.map((host) => ({ host, ...(values[host.id] ?? { stale: true }) })), [pi, values]);
	return {
		feeds,
		readers: pi.map((host) => <HostValue<T> key={host.id} host={host} view={view} onValue={update} />),
		connected,
	};
}

export const dateTime = (t: number | string | null) => t === null ? "Unknown time" : new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function FeedStatus({ feeds, connected }: { feeds: Feed<unknown>[]; connected: boolean }) {
	if (!connected) return <p className="cos-notice" role="status">Hub disconnected. Showing cached evidence; reconnect to refresh it.</p>;
	return <>{feeds.map((f) => f.error || f.stale || f.host.status !== "connected" ? <p className="cos-notice" role="status" key={f.host.id}>{f.host.label}: {f.error ?? (f.value ? "Host away; cached evidence, not current liveness. Reconnect the Host to refresh." : "Reading the Sessions…")}</p> : null)}</>;
}
