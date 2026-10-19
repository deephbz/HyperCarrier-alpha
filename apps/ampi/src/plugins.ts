// HyperCarrier adapters installed into every node: Team (Pi Team Bright semantics), Rarebit, and Auto Compact.
import type { NodePlugin } from "./node/runtime.ts";
import { compactPlugin } from "./plugins/compact.ts";
import { rarebitPlugin } from "./plugins/rarebit.ts";
import { teamPlugin } from "./plugins/team.ts";

export async function hydrate(): Promise<NodePlugin[]> {
	return [teamPlugin(), rarebitPlugin(), compactPlugin()];
}
