import type { HostState } from "../../src/hub/hosts.ts";
import { hostLabel } from "./components/host-label.ts";

// What the Overview may say about Host Session lists that are empty or incomplete (ThreadsState flags).

/** The parts of one Host's list (HostThreads) these rules read. */
type HostList = { host: Pick<HostState, "id" | "label" | "kind">; threads: readonly unknown[]; stale: boolean; indexing?: boolean; error?: string };

/** An empty list that proves no absence yet: not read (stale) or before working-set init. An ended list never loads. */
export const reading = (d: Omit<HostList, "host">): boolean =>
	!d.error && (d.stale || Boolean(d.indexing)) && d.threads.length === 0;

/** The reason each ended list gives, joined; undefined when none ended. */
export const unavailable = (data: Omit<HostList, "stale">[]): string | undefined =>
	data.filter((d) => d.error).map((d) => `${hostLabel(d.host, data.map((other) => other.host))}: ${d.error}`).join(" · ") || undefined;

/** The empty-Overview text: never "No Sessions yet" while a list is still reading or after one ended. */
export function emptyNote(data: HostList[]): string {
	if (data.some(reading)) return "Reading Sessions…";
	return unavailable(data) ?? "No Sessions yet. Start an agent or add a Host to begin.";
}
