// The text the owner copies into a coding agent to add a remote Host. AmPi keeps no remote-setup wizard: the agent
// handles SSH, installs and corner cases, then edits hub.json, which the hub reads only when it starts.

/**
 * The setup prompt. `config` is the hub.json the running hub reads (the hosts frame carries it): the agent runs in
 * another shell, which may not share the hub's AMPI_HOME.
 */
export function hostSetupPrompt(config?: string): string {
	const file = config ? `${config} (the file this hub reads)` : "hub.json in AMPI_HOME (default ~/.ampi/hub.json)";
	return `Add a remote machine to AmPi as a Pi Host. Ask me for its SSH destination if I did not give one.

1. SSH: make \`ssh <alias> true\` work non-interactively with a key (BatchMode=yes). Use a Host alias in ~/.ssh/config. Keep host key checks on.
2. On the remote machine, the non-interactive PATH of \`ssh <alias>\` must have node 22.19 or newer and herdr. Install what is missing. Pi Sessions stay where Pi writes them; AmPi installs nothing else there.
3. On this machine, edit ${file}. Create it if it is missing, and keep every other field. Add to "hosts": { "id": "<alias>", "label": "<alias>", "kind": "pi-ssh" }. The Host ID is the SSH alias.
4. Restart the AmPi hub: stop the running \`ampi hub\` and start it again the same way. The hub reads hub.json only when it starts.
5. Ask me to confirm that <alias> shows as connected in the AmPi sidebar. If it does not, read the hub's output for <alias> and fix the cause.`;
}
