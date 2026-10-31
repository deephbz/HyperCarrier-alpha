// HyperCarrier adapters installed into every node: Team (Pi Team Bright semantics), Rarebit, and Auto Compact.
import { type CompactSettingsPort, compactSettingsPort } from "./node/compact-settings.ts";
import { type ModelRolePort, modelRolePort } from "./node/model-roles.ts";
import type { PiConfigOptions } from "./node/pi-config.ts";
import type { NodePlugin } from "./node/runtime.ts";
import { compactPlugin } from "./plugins/compact.ts";
import { rarebitPlugin } from "./plugins/rarebit.ts";
import { teamPlugin } from "./plugins/team.ts";

/** Node services that plugins receive instead of reading host configuration themselves. */
export type NodePorts = {
	/** The Worker model-role catalog of a working directory, from Pi's settings. */
	modelRoles: ModelRolePort;
	/** Durable Auto Compact settings of a working directory, from Pi's settings. */
	compactSettings: CompactSettingsPort;
};

export function nodePorts(options: PiConfigOptions = {}): NodePorts {
	return { modelRoles: modelRolePort(options), compactSettings: compactSettingsPort(options) };
}

/**
 * The Team plugin reads each lead's model-role catalog from its cwd through `ports.modelRoles`; Auto Compact reads
 * each thread's settings through `ports.compactSettings`. A port left out reads Pi's settings.
 */
export async function hydrate(ports: Partial<NodePorts> = {}): Promise<NodePlugin[]> {
	const { modelRoles, compactSettings } = { ...nodePorts(), ...ports };
	return [rarebitPlugin(), compactPlugin(compactSettings), teamPlugin(modelRoles)];
}
