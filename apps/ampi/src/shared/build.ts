// The build of this AmPi install. `buildId` hashes its source files, so `ampi version` can compare two installs.
// `stamp` here and `compare` in skew.ts are the one way AmPi detects a version difference (P1).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, skewText, type Stamp, stampLabel, VERSION_SKEW } from "./skew.ts";

export { compare, READ_OPS, type Skew, skewText, type Stamp, stampLabel, VERSION_SKEW } from "./skew.ts";

let cached: string | undefined;

/** A hash over the `.ts` files under `root`, with their paths from `/src/` on. */
export function sourceHash(root: string, suffixes: readonly string[] = [".ts"]): string {
	const hash = createHash("sha256");
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (suffixes.some((s) => name.endsWith(s))) hash.update(path.slice(path.lastIndexOf("/src/"))).update(readFileSync(path));
		}
	};
	walk(root);
	return hash.digest("hex").slice(0, 12);
}

export function buildId(): string {
	cached ??= sourceHash(fileURLToPath(new URL("../", import.meta.url)));
	return cached;
}

/** The HEAD committer time of the checkout that holds `dir`. A build without git metadata has no order: it throws. */
export function buildOrder(dir: string): number {
	let out = "";
	try {
		out = execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {}
	const order = Number(out);
	if (!Number.isInteger(order) || order <= 0) throw new Error(`No build order: ${dir} is not in a git checkout with a commit, so AmPi cannot stamp its build.`);
	return order;
}

const APP = fileURLToPath(new URL("../../", import.meta.url));

/** The release line of the checkout: the durable line carries its export fragment. Informational only. */
export function releaseLine(app = APP): Stamp["line"] {
	return existsSync(join(app, "../../release/public/export-manifest.durable.json")) ? "durable" : "stable";
}

let hubStamp: Stamp | undefined;
/**
 * This hub's stamp: its source and the web page it serves (web/dist/index.html names every hashed bundle file), so a
 * page served by another build reads another stamp. Computed once per process.
 */
export function stamp(): Stamp {
	if (hubStamp) return hubStamp;
	const hash = createHash("sha256").update(buildId());
	const index = join(APP, "web/dist/index.html");
	if (existsSync(index)) hash.update(readFileSync(index));
	hubStamp = { id: hash.digest("hex").slice(0, 12), order: buildOrder(APP), line: releaseLine() };
	return hubStamp;
}

let expectedControl: Stamp | undefined;
/**
 * The pi-hc-control stamp this hub expects: the package in this checkout, by the rule its `src/stamp.ts` follows
 * (the `.ts` files under src/, the HEAD committer time). Computed once per process; a checkout without the package
 * or without git metadata throws.
 */
export function controlStamp(): Stamp {
	if (expectedControl) return expectedControl;
	const src = join(APP, "../../packages/pi-hc-control/src");
	if (!existsSync(src)) throw new Error(`No pi-hc-control at ${src}, so AmPi cannot stamp the control it serves.`);
	expectedControl = { id: sourceHash(src, [".ts"]), order: buildOrder(src), line: releaseLine() };
	return expectedControl;
}

/**
 * The build drift of a Host's pi-hc-control, or undefined when it runs this build. `control` is the stamp its status
 * reports; null means it reported none (no git metadata). Drift never refuses an op: the deploy parts row shows the
 * message and the hub logs `detail`, which names both stamps.
 */
export function controlSkew(expected: Stamp, control: Stamp | null | undefined, host: string): (Error & { code: string; detail: string }) | undefined {
	const skew = control ? compare(expected, control) : "unstamped";
	if (skew === "same") return undefined;
	const message = skew === "older" ? skewText.controlOlder(host, control!.id) : skew === "newer" ? skewText.controlNewer(host) : skewText.controlUnstamped(host);
	const detail = `pi-hc-control on ${host}: ${stampLabel(control)}; this AmPi expects ${stampLabel(expected)}.`;
	return Object.assign(new Error(message), { code: VERSION_SKEW, detail });
}

/**
 * The refusal for a Host's pi-hc-control that speaks another protocol than `expected` (endpoint.ts SCHEMA), or that
 * names it but answered `unknownOp` with unknown_op.
 */
export function controlProtocolSkew(expected: string, control: string, host: string, unknownOp?: string): Error & { code: string; detail: string } {
	const unknown = unknownOp !== undefined && control === expected;
	const message = unknown ? skewText.controlUnknownOp(host, control) : skewText.controlProtocol(host, control, expected);
	const detail = `pi-hc-control on ${host} speaks ${control}${unknown ? ` without the ${unknownOp} op` : ""}; this AmPi speaks ${expected}.`;
	return Object.assign(new Error(message), { code: VERSION_SKEW, detail });
}
