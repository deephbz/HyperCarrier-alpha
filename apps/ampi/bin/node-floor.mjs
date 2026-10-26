// The oldest Node release on each line that AmPi accepts. CVE-2026-111497 (Brotli in zlib and fetch) is fixed only in
// these releases; Node 23 and 25 are end-of-life and have no fix. package.json `engines.node` states the same floor.
export const NODE_FLOOR = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };
export const NODE_RANGE = "^22.23.4 || ^24.22.1 || >=26.12.1";

/** Whether a Node version string ("24.22.1" or "v24.22.1") is at or above the floor of its line. */
export function nodeIsPatched(version) {
	const v = String(version).replace(/^v/, "").split(".").map(Number);
	if (v.length < 3 || v.some((n) => !Number.isInteger(n))) return false;
	const floor = v[0] > 26 ? [v[0], 0, 0] : NODE_FLOOR[v[0]];
	if (!floor) return false;
	for (let i = 0; i < 3; i++) if (v[i] !== floor[i]) return v[i] > floor[i];
	return true;
}
