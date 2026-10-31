// Pinned Sessions: the owner's short list of Sessions to keep at the top of the sidebar. The hub owns the list, so the
// desktop app and a phone see the same pins, and clearing browser storage keeps them.
// A pin names one Session by its threadId, which is unique across Hosts (Pi "pi:<uuid>", durable
// "<storeId>.<conversationId>"). The same Session seen on two Host routes, such as a pi-local and a pi-ssh route to one
// machine, is one pin. `host` is only a hint: the Host that last listed the Session. The sidebar uses it to choose a
// Host and to say "Not found on <host>". The order of the list is the order of pinning.
// Only an owner action (`pins.set`: the star, the row menu, the ×) changes which Sessions are pinned. A window that
// sees the Session on another Host sends `pins.hint`, which moves the hint of a pin that still exists and nothing else.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Pin } from "../shared/protocol.ts";
import type { HubHome } from "./home.ts";

type PinsFile = { version: 1; pins: Pin[] };

/**
 * The list in memory, written through to pins.json in the hub's home; a hub without a home keeps pins until it stops.
 * The home's one hub is the file's only writer, so the list read at start stays the file's content.
 */
export class Pins {
	readonly path: string | undefined;
	#pins: Pin[];
	/** Why a write is refused: a file of an unknown version, or an unreadable file that could not move aside. */
	#refuse: string | undefined;

	constructor(home?: HubHome) {
		this.path = home?.file("pins.json");
		this.#pins = this.path ? this.#read(this.path) : [];
	}

	list(): Pin[] {
		return this.#pins;
	}

	/**
	 * Applies the owner's intent for one Session: pinned or not pinned. A repeated intent keeps membership and the place,
	 * so a click in a window that has not yet seen the last change still ends in the state the owner clicked. `host` goes
	 * in only when the pin is created, and `hint` moves it later; a repeated pin with a new title renames in place.
	 * Only a marked owner click (`owner`) creates a pin: a page built before `pins.hint` sends its hint repair as an
	 * unmarked pin, and that must not bring back a pin the owner removed. An unmarked unpin or repeated pin applies. The write is synchronous: two calls cannot interleave in
	 * the hub process, and a refused write leaves the list unchanged.
	 */
	set(threadId: string, pinned: boolean, host = "", title = "", owner = false): Pin[] {
		if (this.#refuse) throw new Error(this.#refuse);
		const at = this.#pins.findIndex((pin) => pin.threadId === threadId);
		if (pinned && at < 0 && !owner) throw new Error("This page is older than the hub. Reload it.");
		if (pinned && at < 0 && !host) throw new Error("A new pin needs a host");
		let next = this.#pins;
		if (!pinned && at >= 0) next = this.#pins.filter((_, i) => i !== at);
		else if (pinned && at < 0) next = [...this.#pins, { host, threadId, title }];
		else if (pinned && title && this.#pins[at]!.title !== title) next = this.#pins.map((pin, i) => (i === at ? { ...pin, title } : pin));
		if (next === this.#pins) return next;
		if (this.path) save(this.path, next);
		this.#pins = next;
		return next;
	}

	/**
	 * Moves the host hint of an existing pin; returns the new list, or undefined when nothing changed. It never creates a
	 * pin, so a hint that arrives after an unpin cannot bring the pin back.
	 */
	hint(host: string, threadId: string): Pin[] | undefined {
		if (this.#refuse) throw new Error(this.#refuse);
		const at = this.#pins.findIndex((pin) => pin.threadId === threadId);
		if (at < 0 || !host || this.#pins[at]!.host === host) return undefined;
		const next = this.#pins.map((pin, i) => (i === at ? { ...pin, host } : pin));
		if (this.path) save(this.path, next);
		this.#pins = next;
		return next;
	}

	/**
	 * A missing file is an empty list. A file of another version stays as it is and makes the list read-only. A file
	 * that does not parse moves aside, so the next pin cannot overwrite what it held; if it cannot move, this run
	 * refuses writes.
	 */
	#read(path: string): Pin[] {
		if (!existsSync(path)) return [];
		let parsed: Partial<PinsFile> | undefined;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PinsFile>;
			if (parsed?.version === 1 && !Array.isArray(parsed.pins)) throw new Error("a version 1 pins file without a pins list");
		} catch (error) {
			const aside = `${path}.unreadable-${Date.now()}`;
			try {
				renameSync(path, aside);
				console.warn(`pins: ${path} is unreadable (${(error as Error).message}); moved to ${aside}, starting with no pins`);
			} catch (renameError) {
				this.#refuse = `${path} is unreadable and could not be moved aside (${(renameError as Error).message}); pins are read-only until AmPi restarts`;
				console.warn(`pins: ${this.#refuse}`);
			}
			return [];
		}
		if (parsed?.version !== 1) {
			this.#refuse = `${path} has version ${JSON.stringify(parsed?.version)}; this AmPi reads version 1, so pins are read-only`;
			return [];
		}
		return dedup(parsed.pins!);
	}
}

/**
 * One pin per threadId: the first place in the list, the newest host hint and title. Older hubs wrote an `at` field
 * and may have pinned one Session under two Host ids; both forms read here.
 */
function dedup(stored: unknown[]): Pin[] {
	const pins: Pin[] = [];
	const at = new Map<string, number>();
	for (const raw of stored) {
		const pin = raw as Partial<Pin> | null;
		if (typeof pin?.threadId !== "string" || !pin.threadId) continue;
		const next = { host: typeof pin.host === "string" ? pin.host : "", threadId: pin.threadId, title: String(pin.title ?? "") };
		const i = at.get(next.threadId);
		if (i === undefined) { at.set(next.threadId, pins.length); pins.push(next); }
		else pins[i] = { host: next.host || pins[i]!.host, threadId: next.threadId, title: next.title || pins[i]!.title };
	}
	return pins;
}

/** Exported for the test of a failed rename. */
export function save(path: string, pins: Pin[]): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Write then rename: a reader or a crash never sees a partial list.
	const next = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(next, `${JSON.stringify({ version: 1, pins } satisfies PinsFile, null, 2)}\n`, { mode: 0o600 });
		renameSync(next, path);
	} catch (error) {
		rmSync(next, { force: true });
		throw error;
	}
}
