// Pi's model registry for the hub's helper calls (helper-models.ts ModelRegistry): `pi --list-models`, which lists only
// providers with usable authentication. The node's in-process list
// (src/node/models.ts) holds only pi-ai's built-in providers; Pi's CLI also loads models.json providers (such as a
// local gateway) and extension providers, so the hub asks Pi itself.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CarrierModel, ModelRegistry } from "../hub/helper-models.ts";

const unreadable = (message: string) => Object.assign(new Error(message), { code: "registry_unreadable" });

/**
 * The rows of `pi --list-models` output. The header may follow a few banner lines, such as an update notice. Output
 * without Pi's header within its first five lines throws: Pi's list format changed.
 */
export function parsePiModels(text: string): CarrierModel[] {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	const head = lines.slice(0, 5).findIndex((l) => l.startsWith("No models available") || /^provider\s+model\s/.test(l));
	if (head < 0) throw unreadable(`Pi's model list format changed: no "provider model" header. It began: ${JSON.stringify((lines[0] ?? "").slice(0, 80))}`);
	if (lines[head]!.startsWith("No models available")) return [];
	return lines.slice(head + 1).map((l) => l.split(/\s+/)).filter((c) => c.length >= 2).map(([provider, id]) => ({ provider: provider!, id: id! }));
}

const REGISTRY_TTL_MS = 5 * 60_000;
/** A `--list-models` read longer than this is killed. Tests shorten it with setListTimeout. */
let LIST_TIMEOUT_MS = 30_000;
export function setListTimeout(ms: number): void { LIST_TIMEOUT_MS = ms; }
// One cache for the hub process, keyed on the Pi binary and agent dir, so a test or hub that changes either reads anew.
let registry: { key: string; at: number; models: Promise<CarrierModel[]>; settled: boolean } | undefined;
const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/**
 * `pi --list-models` on the hub, cached for five minutes per Pi binary and agent dir; `fresh` reads it again. A read
 * still running serves every caller, fresh or not, so concurrent misses spawn Pi once.
 */
function list(fresh: boolean): Promise<CarrierModel[]> {
	const bin = process.env.PI_BIN || "pi", key = `${bin}\0${agentDir()}`;
	if (registry?.key === key && (!registry.settled || (!fresh && Date.now() - registry.at < REGISTRY_TTL_MS))) return registry.models;
	const models = new Promise<CarrierModel[]>((resolve, reject) => {
		let out = "";
		const child = spawn(bin, ["--list-models"], { stdio: ["ignore", "pipe", "ignore"] });
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, LIST_TIMEOUT_MS);
		child.stdout.on("data", (d) => (out += d));
		child.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(unreadable(`Pi's model list could not be read: cannot run ${bin} (${e.code ?? e.message}); check PI_BIN.`)); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(unreadable(`Pi's model list could not be read: cannot run ${bin} --list-models (${timedOut ? `timed out after ${LIST_TIMEOUT_MS / 1000} s` : `exit ${code}`}); check PI_BIN.`));
			try { resolve(parsePiModels(out)); } catch (e) { reject(e); }
		});
	});
	// A failed read or an empty table is never cached: the next call reads Pi again.
	const entry: NonNullable<typeof registry> = registry = { key, at: Date.now(), models, settled: false };
	models.then((rows) => { entry.settled = true; if (!rows.length && registry === entry) registry = undefined; }, () => { entry.settled = true; if (registry === entry) registry = undefined; });
	return models;
}

export const piModelRegistry: ModelRegistry = { list };
