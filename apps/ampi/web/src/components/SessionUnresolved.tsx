import { useEffect, useState } from "react";
import type { HostState } from "../client.ts";
import { href } from "../util.ts";
import { HubNotConnected } from "./Sidebar.tsx";

const QUIET_MS = 300;
const LIST_WAIT_MS = 5000;

/** The time since mount, in steps: 0 before `QUIET_MS`, 1 before `LIST_WAIT_MS`, 2 after. */
function useWaited(): 0 | 1 | 2 {
	const [waited, setWaited] = useState<0 | 1 | 2>(0);
	useEffect(() => {
		const timers = [setTimeout(() => setWaited(1), QUIET_MS), setTimeout(() => setWaited(2), LIST_WAIT_MS)];
		return () => timers.forEach(clearTimeout);
	}, []);
	return waited;
}

/**
 * The main view of a Session route that names no listed Host source (App's linkRoute): it says why, and what to do.
 * A fast boot shows an empty view for `QUIET_MS`, so a hub that answers at once causes no flash.
 */
export function SessionUnresolved({ host, hosts, connected, listed }: { host: string; hosts: readonly HostState[]; connected: boolean; listed: boolean }) {
	const waited = useWaited();
	const sources = hosts.filter((h) => h.id === host);
	return (
		<div className="main">
			<div className="empty" data-session-unresolved={!connected ? "disconnected" : !listed ? "unlisted" : "no-host"}>
				{waited === 0 && !listed ? null : !connected ? (
					<HubNotConnected />
				) : !listed ? (
					waited === 1 ? "Connecting to the hub…" : <>
						The hub has not listed its Hosts. <button className="btn small" onClick={() => location.reload()}>Reload</button>
					</>
				) : (
					<>
						{sources.length === 0
							? `This Host is not listed: ${host}.`
							: `This Session's agent type is not on Host ${sources[0]!.label}.`}{" "}
						<a href={href.page("overview")}>Open the Overview</a>
					</>
				)}
			</div>
		</div>
	);
}
