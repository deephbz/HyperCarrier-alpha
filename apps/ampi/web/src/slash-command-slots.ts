import type { SlashCommand } from "../../src/shared/protocol.ts";
type LocalCommand = { name: string; args?: string; help: string; disabled?: boolean; run?: (arg: string) => Promise<void> | void };

/** Keep local command names in place while supported Pi commands retain dispatch authority. */
export function slashCommandSlots(local: LocalCommand[], remote: SlashCommand[], stop: LocalCommand, unsupported: string): LocalCommand[] {
	const locals = local.filter((command) => command.name !== "stop");
	const supported = new Map(remote.filter((command) => command.supported).map((command) => [command.name, command]));
	const slots = locals.map((command): LocalCommand => {
		const winner = supported.get(command.name);
		return winner
			? { name: winner.name, args: winner.argsHint, help: winner.description ?? winner.source }
			: command;
	});
	const localNames = new Set(locals.map((command) => command.name));
	for (const command of remote) {
		if (command.name === "stop" || localNames.has(command.name)) continue;
		slots.push({
			name: command.name,
			args: command.argsHint,
			help: command.supported ? (command.description ?? command.source) : unsupported,
			disabled: !command.supported,
		});
	}
	return [stop, ...slots];
}
