// The durable node as a Host kind (host-kinds.ts) and its key bindings (keymap.ts), registered in extensions.ts.
// Pure: routes, labels and node tests read it.

import type { HostKind } from "../host-kinds.ts";
import type { KeyBinding } from "../keymap.ts";
import { isPiThreadId, type ThreadSummary } from "../../../src/shared/protocol.ts";

declare module "../keymap.ts" {
	interface ExtraKeyActions {
		archive: true;
	}
}

/**
 * A durable node: every Host that is not Pi's, local or over SSH. The hub serves the Pi-shaped Host ops for it from
 * its reader copy (node-design.md, step 8). New work prefers it over the Pi source of the same Host.
 */
export const DURABLE_KIND: HostKind = {
	source: "durable",
	sourceLabel: "durable",
	matches: (host) => host.kind !== "pi-local" && host.kind !== "pi-ssh",
	ownsThread: (id) => !isPiThreadId(id),
	herdr: false,
	reader: true,
	citation: "pi-durable:",
	preferNew: true,
};

/** A durable thread sits in a tab with no pane; the node's layout lists the thread ID as the pane. */
export const tabPane = (t: ThreadSummary) => t.location?.pane ?? (t.location?.tab ? t.id : undefined);

export const DURABLE_KEYS: KeyBinding[] = [
	{ id: "archive", code: "KeyA", meta: true, shift: true, label: "Archive or unarchive this thread", region: "global", palette: true, browserOwned: true, context: "in a durable thread", note: "⌘⇧A in AmPi.app; in a browser, use the command palette (Chrome owns ⌘⇧A)" },
];
