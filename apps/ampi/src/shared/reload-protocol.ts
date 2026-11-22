// The durable node's `thread.reload` op, added to the wire through the `ExtraOps` extension point (protocol.ts).
// A Pi Host does not serve it. A Pi Session relaunches instead (`thread.relaunch`): a different verb, which stops Pi
// in its pane and starts it again.

import type { OpSpec } from "./protocol.ts";

/**
 * What a reload re-read, for the owner. A reload commits nothing and interrupts no thread. `providers`: the providers in
 * the host catalog after the re-read. `warnings`: models.json layers that were skipped, a models file that did not
 * parse (the previous catalog stays), and a thread model that the catalog no longer has.
 */
export type ThreadReloaded = {
	threadId: string;
	reloaded: ("models" | "settings" | "resources")[];
	providers: number;
	warnings: string[];
};

declare module "./protocol.ts" {
	interface ExtraOps {
		"thread.reload": OpSpec<{ threadId: string }, ThreadReloaded>;
	}
}
