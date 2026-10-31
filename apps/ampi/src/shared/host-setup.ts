// The text the owner copies into a coding agent to add a remote Host. AmPi keeps no remote-setup wizard: the agent
// handles SSH, installs and corner cases, then edits hub.json, which the hub reads only when it starts.

/**
 * The setup prompt. `config` is the hub.json the running hub reads (the hosts frame carries it): the agent runs in
 * another shell, which may not share the hub's AMPI_HOME.
 */
export function hostSetupPrompt(config?: string): string {
	const file = config ? `${config} (the file this hub reads)` : "hub.json in AMPI_HOME (default ~/.ampi/hub.json)";
	return `Add a remote machine to AmPi as a durable Host. Ask me for its SSH destination if I did not give one.

1. SSH: make \`ssh <alias> true\` work non-interactively with a key (BatchMode=yes). Use a Host alias in ~/.ssh/config. Keep host key checks on.
2. On the remote machine, the non-interactive PATH of \`ssh <alias>\` must have node (22.23.4+, 24.22.1+, or 26.12.1+), herdr, and ampi. Install AmPi there from the durable line of the HyperCarrier repository (branch release/durable) with apps/ampi/scripts/setup.sh, then check that \`ssh <alias> ampi doctor\` passes. If doctor says no model is signed in, tell me: new agents there run the offline simulator until I sign in a model for that Host in the AmPi window.
3. On this machine, edit ${file}. Create it if it is missing, and keep every other field. Add to "hosts": { "id": "<alias>", "label": "<alias>", "kind": "ssh", "target": "<alias>" }. The Host ID is the SSH alias. To show that machine's Pi Sessions too, also add { "id": "<alias>", "label": "<alias>", "kind": "pi-ssh" }.
4. Restart the AmPi hub: stop the running \`ampi hub\` and start it again the same way. The hub reads hub.json only when it starts.
5. Ask me to confirm that <alias> shows as connected in the AmPi sidebar. If it does not, read the hub's output for <alias> and fix the cause.`;
}
