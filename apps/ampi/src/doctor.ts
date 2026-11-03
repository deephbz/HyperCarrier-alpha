// `ampi doctor`: checks this machine and its hub the way AmPi will use them, and says how to fix each problem.
// It never changes anything. Exit code 1 when something blocks use.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hubConfigPath, hubProof, loadHubConfig } from "./hub/hub.ts";
import { hubOwner, readHubToken } from "./hub/home.ts";
import { ampiHome } from "./shared/home.ts";
import { DURABLE_RELEASE, type SkippedHost } from "./shared/protocol.ts";
import { buildId } from "./shared/build.ts";
// @ts-ignore: a plain ESM script without types
import { webDistCurrent } from "../scripts/web-inputs.mjs";

const run = promisify(execFile);
const WEB_INDEX = fileURLToPath(new URL("../web/dist/index.html", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../../../", import.meta.url));

type Level = "ok" | "warn" | "fail";
const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };
let failures = 0;

function report(level: Level, what: string, fix?: string): void {
	if (level === "fail") failures++;
	console.log(`${MARK[level]} ${what}`);
	if (fix && level !== "ok") console.log(`    → ${fix}`);
}

/** The hub's port: --port, else AMPI_HUB_PORT, else the port the last `ampi hub` used, else 7878. */
export function hubPort(flagValue?: string): number {
	if (flagValue) return Number(flagValue);
	if (process.env.AMPI_HUB_PORT) return Number(process.env.AMPI_HUB_PORT);
	try {
		const recorded = Number(readFileSync(join(ampiHome(), "hub.port"), "utf8").trim());
		if (recorded > 0) return recorded;
	} catch {}
	return 7878;
}

export function versionLine(): string {
	const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
	return `ampi ${pkg.version} build ${buildId()} node ${process.versions.node}`;
}

/**
 * Whether web/dist was built from this checkout's web inputs (scripts/web-inputs.mjs). The hub serves web/dist as it
 * is, so a stale build shows an older window under this hub's build stamp; `ampi doctor` and the hub start log say it.
 */
export function webBuild(): { ok: boolean; detail: string } {
	return webDistCurrent(CHECKOUT) as { ok: boolean; detail: string };
}

/**
 * What this hub skips in a shared AMPI_HOME: hub.json rows of durable Hosts and durable threads. The durable release
 * serves them, so doctor says it (the window also names skipped Hosts).
 */
export function configNotes(home: string, skipped: readonly SkippedHost[]): { what: string; fix: string }[] {
	const notes: { what: string; fix: string }[] = [];
	if (skipped.length)
		notes.push({
			what: `hub.json lists durable Host${skipped.length === 1 ? "" : "s"} ${skipped.map((host) => `${host.label} (${host.kind})`).join(", ")}; this hub serves Pi Hosts only and skips them`,
			fix: `${DURABLE_RELEASE} Otherwise remove the rows from hub.json.`,
		});
	let threads = 0;
	try {
		threads = readdirSync(join(home, "threads")).length;
	} catch {}
	if (threads > 0) notes.push({ what: `${threads} durable thread${threads === 1 ? "" : "s"} in ${join(home, "threads")}; this hub does not show them`, fix: DURABLE_RELEASE });
	return notes;
}

export async function doctor(): Promise<number> {
	console.log(`${versionLine()}\n`);
	console.log("This machine");
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	if (major > 22 || (major === 22 && minor >= 19)) report("ok", `Node ${process.versions.node}`);
	else report("fail", `Node ${process.versions.node} is too old`, "Install Node 22.19 or newer (it runs AmPi's TypeScript directly).");

	const web = existsSync(WEB_INDEX) ? webBuild() : undefined;
	if (web?.ok) report("ok", "Window built");
	else if (web) report("warn", "The window (web UI) was built from other files", web.detail);
	else report("fail", "The window (web UI) is not built", "npm run build:web -w @hypercarrier/ampi (from the repository root), or run apps/ampi/scripts/setup.sh");

	const onPath = await run("sh", ["-c", "command -v ampi"]).then(
		(r) => r.stdout.trim(),
		() => "",
	);
	const entry = fileURLToPath(new URL("../bin/ampi.mjs", import.meta.url));
	let launcher = "";
	try {
		launcher = readFileSync(onPath, "utf8");
	} catch {}
	if (onPath && !launcher.includes(entry))
		report("warn", `ampi on PATH (${onPath}) runs another copy of AmPi`, `Put this checkout's launcher first: apps/ampi/scripts/setup.sh --bin-dir <a directory early on PATH>, or remove ${onPath}.`);
	else if (onPath) report("ok", `ampi on PATH (${onPath})`);
	else report("warn", "ampi is not on PATH", "Run apps/ampi/scripts/setup.sh, or add its bin directory to PATH.");

	console.log("\nHub");
	const port = hubPort();
	const token = readHubToken();
	// One hub owns this home; a second `ampi hub` on it refuses to start and names this owner.
	const owner = hubOwner();
	if (owner) report("ok", `Hub pid ${owner.pid} owns ${ampiHome()}${owner.port ? ` (port ${owner.port})` : ""}`);
	try {
		const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).json()) as { proof?: string };
		if (token && health.proof === hubProof(token)) report("ok", `Hub running: http://127.0.0.1:${port}/?k=… (ampi open prints the full link)`);
		else report("fail", `Something else answers on port ${port}`, "Stop it, or start AmPi on another port: ampi hub --port 7879 (open and doctor then find it there).");
	} catch {
		if (owner) report("fail", `Hub pid ${owner.pid} does not answer on port ${port}`, `It may still be starting. If it stays silent, stop it (kill ${owner.pid}) and start again: ampi hub`);
		else report("ok", `Hub not running; start it with: ampi hub`);
	}

	const config = loadHubConfig(hubConfigPath());
	for (const note of configNotes(ampiHome(), config.skipped ?? [])) report("warn", note.what, note.fix);

	console.log(failures ? `\n${failures} problem${failures === 1 ? "" : "s"} to fix.` : "\nReady.");
	return failures ? 1 : 0;
}
