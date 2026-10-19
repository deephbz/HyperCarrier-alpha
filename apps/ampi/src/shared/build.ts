// The build fingerprint of this AmPi install: a hash over its source and package files. Nodes outlive the hub and
// windows, so a host can run an older build than the hub after an update; comparing fingerprints makes that visible.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function buildId(): string {
	if (cached) return cached;
	const hash = createHash("sha256");
	const roots = [fileURLToPath(new URL("../", import.meta.url))];
	for (const pkg of ["durable-team", "durable-rarebit", "durable-compact"]) roots.push(fileURLToPath(new URL(`../../../../packages/${pkg}/src/`, import.meta.url)));
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
			else if (name.endsWith(".ts")) hash.update(path.slice(path.lastIndexOf("/src/"))).update(readFileSync(path));
		}
	};
	for (const root of roots) walk(root);
	cached = hash.digest("hex").slice(0, 12);
	return cached;
}
