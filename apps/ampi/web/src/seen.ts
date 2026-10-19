// When the owner last looked at each Session (by ref), on this browser. It turns "the agent stopped and is idle" into
// "an answer you have not read": the Timeline's "needs you" (one-gui-views.md §3.3). Display state only, never sent.

const KEY = "ampi.seen";
const LIMIT = 500;

function load(): Record<string, number> {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
	} catch {
		return {};
	}
}

export function seenAt(ref: string): number {
	return load()[ref] ?? 0;
}

export function markSeen(ref: string, at = Date.now()): void {
	const all = load();
	all[ref] = at;
	const refs = Object.keys(all);
	if (refs.length > LIMIT) for (const old of refs.sort((a, b) => all[a]! - all[b]!).slice(0, refs.length - LIMIT)) delete all[old];
	try {
		localStorage.setItem(KEY, JSON.stringify(all));
	} catch {}
}
