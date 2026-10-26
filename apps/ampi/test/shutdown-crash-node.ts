// Test-only node: snapshot persisted Team stop intent through the store's sole owner.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { TeamDoc } from "@hypercarrier/pi-team-durable/authority";
import { runDaemon } from "../src/node/daemon.ts";
import { teamPlugin } from "../src/plugins/team.ts";

const [, home] = process.argv.slice(2);
process.env.AMPI_ENTRY_LOG = join(home!, "entries-before.jsonl");
process.env.AMPI_STOP_LOG = join(home!, "stops-before.jsonl");
process.env.AMPI_STOP_LATCH = join(home!, "release");
const daemon = await runDaemon({ home: home!, simTokensPerSecond: 2000, plugins: [teamPlugin()] });
process.on("message", async (message: { command: string; threadId: string }) => {
	try {
		if (message.command !== "snapshot") return;
		const { store } = await daemon.runtime.thread(message.threadId);
		const team = await store.harness.snapshot(TeamDoc, BACKGROUND_CONTEXT);
		process.send!({ type: "snapshot", value: team });
	} catch (error) {
		process.send!({ type: "failure", value: String(error) });
	}
});
process.once("disconnect", () => process.exit());
process.send!({ type: "ready", value: { socket: daemon.socket } });
