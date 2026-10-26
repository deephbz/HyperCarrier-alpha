// Test-only node process for the Esc crash case. `seed` stops after Esc marks only its first target; `reopen` runs clean.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { runDaemon } from "../src/node/daemon.ts";
import { EscDoc } from "../src/node/runtime.ts";
import { heldSummaries } from "./helpers.ts";

const [, dir, mode] = process.argv.slice(2);
const ledger = join(dir!, `${mode}-ledger.jsonl`);
process.env.AMPI_ENTRY_LOG = ledger;
process.env.AMPI_STOP_LOG = ledger;
if (mode === "seed") process.env.AMPI_FAULT = "esc-first-mark";
else delete process.env.AMPI_FAULT;
const send = (type: string, value: unknown, name?: string) => process.send!({ type, value, name });
const { models, state } = heldSummaries();
// After the kill, any summary request is held and counted: a resumed compaction cannot finish unseen.
if (mode !== "seed") state.arm("uncooperative");
const daemon = await runDaemon({
	home: join(dir!, "home"),
	models,
	plugins: [{
		extensions: [],
		settings: { retry: { maxRetries: 0 }, compaction: { keepRecentTokens: 256 } },
		attach(store) {
			const resume = store.harness.resume.bind(store.harness);
			store.harness.resume = () => {
				appendFileSync(ledger, JSON.stringify({ kind: "scheduler-start", store: store.id }) + "\n");
				return resume();
			};
		},
	}],
});
process.on("message", async (message: { command: string; name: string; threadId?: string; taskIds?: string[]; mode?: "cooperative" | "uncooperative" }) => {
	try {
		if (message.command === "arm") state.arm(message.mode);
		if (message.command === "snapshot") {
			const { store } = await daemon.runtime.thread(message.threadId!);
			const inspection = await store.harness.inspect(BACKGROUND_CONTEXT);
			const esc = await store.harness.snapshot(EscDoc, BACKGROUND_CONTEXT);
			const live = new Set(inspection.tasks.map(({ record }) => String(record.id)));
			const outcomes: Record<string, string> = {};
			for (const id of message.taskIds ?? []) if (!live.has(id)) outcomes[id] = (await store.harness.waitForTask(Number(id) as never, BACKGROUND_CONTEXT)).state.outcome.status;
			send(message.command, {
				held: state.held,
				tasks: inspection.tasks.map(({ record }) => ({ id: String(record.id), status: record.state.status, abortRequested: record.abortRequested })),
				outcomes,
				intents: Object.keys(esc?.intents ?? {}),
			}, message.name);
			return;
		}
		send(message.command, { held: state.held }, message.name);
	} catch (error) {
		send("failure", String((error as Error).stack ?? error));
	}
});
send("ready", { socket: daemon.socket });
