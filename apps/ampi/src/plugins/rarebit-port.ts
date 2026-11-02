// The /rarebit command port. The command body lives in rarebit.ts; rarebitPlugin().attach is the only writer of
// commandPorts. Node core (commands.ts) calls rarebitCommand through this leaf, so it does not import the plugin
// module, and the plugin's imports of server.ts and commands.ts form no cycle. Keep both type imports whole-clause
// `import type`: Node keeps an inline `import { type X }` as a module load, which would recreate the cycle.

import type { CommandResult } from "../node/commands.ts";
import { NodeError } from "../node/errors.ts";
import type { Store } from "../node/runtime.ts";

type CommandPort = (conversationId: string, args: string, key?: string) => Promise<CommandResult>;
export const commandPorts = new WeakMap<Store, CommandPort>();
/** Called inside runtime.admit; the plugin owns jobs and their receipts. */
export function rarebitCommand(store: Store, conversationId: string, args: string, key?: string): Promise<CommandResult> {
	const port = commandPorts.get(store);
	if (!port) throw new NodeError("unavailable", "Rarebit is unavailable on this node.");
	return port(conversationId, args, key);
}
