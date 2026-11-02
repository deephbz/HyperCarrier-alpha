// Line fragments: the durable line keeps its own export entries and test lanes in committed files beside the shared
// ones, so the shared files can stay identical on both lines.
//
//   release/public/export-manifest.json  + release/public/export-manifest.durable.json
//   apps/ampi/test-lanes.json            + apps/ampi/test-lanes.durable.json
//
// A fragment is optional, and its name is fixed: there is no discovery. Every reader takes the merged view. A fragment
// resolves beside the base path it is given, so an export reads the fragment from its committed snapshot. The public
// tree receives the merged view and never a fragment file.
//
// Export manifest fragment: { schemaVersion: 1, retire, omit, submoduleProjections, entries }
//   retire                 base entry sources the line deletes. Each one names exactly one base entry, and its file must
//                          be absent from the tree.
//   omit                   { "<test-lanes entry to>": [test names] }, appended to that entry's omit list
//   submoduleProjections   appended to the base projections
//   entries                appended to the base entries; a source or destination the base already has is rejected
// Merged view: the base document with the retired entries removed, the omit lists extended, and the projections and
// entries appended. Its text is JSON.stringify(view, null, 2) + "\n", the text exportManifestSha256 hashes; without a
// fragment that text is the base text.
//
// Test lanes fragment: { version: 1, retire, insert, costs }
//   retire   lane rows to remove from the base lanes. A row in both retire and insert moves.
//   insert   { "<lane>": [{ after, files }] }: each group goes directly after the row `after` (null: the start)
//   costs    [{ after, costs }]: cost hints placed directly after the key `after` (null: the start)
// A missing anchor, an unknown retired row and a duplicated row fail the load, so a renamed or deleted base row
// cannot shift the line's order silently.
const fs = require("node:fs");
const path = require("node:path");

const LINE = "durable";
const MANIFEST_KEYS = new Set(["schemaVersion", "retire", "omit", "submoduleProjections", "entries"]);
const LANES_KEYS = new Set(["version", "retire", "insert", "costs"]);

/** The fragment path beside a base file: x/name.json -> x/name.durable.json. */
function fragmentPath(basePath) {
	if (!basePath.endsWith(".json")) throw new Error(`line fragment base must be a .json file: ${basePath}`);
	return `${basePath.slice(0, -".json".length)}.${LINE}.json`;
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readFragment(basePath) {
	const file = fragmentPath(basePath);
	return fs.existsSync(file) ? readJson(file) : undefined;
}

function display(file, root) {
	return root ? path.relative(root, file).split(path.sep).join("/") : file;
}

function stringList(value, label) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of strings`);
	return value;
}

function checkKeys(document, allowed, name) {
	if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(`${name} must be a JSON object`);
	const unknown = Object.keys(document).filter((key) => !allowed.has(key));
	if (unknown.length) throw new Error(`${name} has unsupported keys: ${unknown.join(", ")}`);
}

/**
 * The merged export manifest. `names` labels the two files in errors. `root`, when given, is the tree the manifest
 * describes: a retired source must be absent from it. `fragmentSources` lists the fragment paths (relative to that
 * tree) that no entry may name.
 */
function mergeExportManifest(base, fragment, { names = ["base", "fragment"], root, fragmentSources = [] } = {}) {
	const [baseName, fragmentName] = names;
	const forbidden = new Set(fragmentSources);
	const rejectFragmentEntry = (entries, name) => {
		for (const entry of entries) for (const side of [entry.from, entry.to]) {
			if (forbidden.has(side)) throw new Error(`${name} exports the line fragment ${side}; the export takes the merged view and never a fragment file`);
		}
	};
	rejectFragmentEntry(base.entries ?? [], baseName);
	if (fragment === undefined) return base;
	checkKeys(fragment, MANIFEST_KEYS, fragmentName);
	if (fragment.schemaVersion !== 1) throw new Error(`${fragmentName} needs schemaVersion 1`);
	const entries = fragment.entries ?? [];
	if (!Array.isArray(entries)) throw new Error(`${fragmentName} entries must be an array`);
	rejectFragmentEntry(entries, fragmentName);
	const retire = stringList(fragment.retire, `${fragmentName} retire`);
	const retired = new Set();
	for (const from of retire) {
		const matches = base.entries.filter((entry) => entry.from === from);
		if (matches.length !== 1) throw new Error(`${fragmentName} retires ${from}, which ${matches.length ? "more than one" : "no"} entry in ${baseName} exports`);
		if (root && fs.existsSync(path.join(root, from))) throw new Error(`${fragmentName} retires ${from}, but the file exists; delete it or drop the retire row (${baseName} exports it)`);
		retired.add(from);
	}
	const kept = base.entries.filter((entry) => !retired.has(entry.from));
	for (const entry of entries) {
		const clash = kept.find((other) => other.from === entry.from || other.to === entry.to);
		if (clash) throw new Error(`${entry.from} -> ${entry.to} is in both ${baseName} and ${fragmentName}; keep one entry`);
	}
	const omit = fragment.omit ?? {};
	if (!omit || typeof omit !== "object" || Array.isArray(omit)) throw new Error(`${fragmentName} omit must map a test-lanes destination to test names`);
	for (const to of Object.keys(omit)) {
		const owner = kept.find((entry) => entry.to === to && entry.kind === "test-lanes");
		if (!owner) throw new Error(`${fragmentName} omits tests from ${to}, which is no test-lanes entry in ${baseName}`);
		if (!Array.isArray(owner.omit)) throw new Error(`the test-lanes entry for ${to} in ${baseName} needs an omit array before ${fragmentName} can extend it`);
		for (const name of stringList(omit[to], `${fragmentName} omit for ${to}`)) {
			if (owner.omit.includes(name)) throw new Error(`${name} is omitted from ${to} in both ${baseName} and ${fragmentName}`);
		}
	}
	const projections = fragment.submoduleProjections ?? [];
	if (!Array.isArray(projections)) throw new Error(`${fragmentName} submoduleProjections must be an array`);
	for (const projection of projections) {
		if ((base.submoduleProjections ?? []).some((other) => other.path === projection.path)) throw new Error(`submodule ${projection.path} is projected in both ${baseName} and ${fragmentName}`);
	}
	const merged = { ...base };
	merged.entries = [...kept.map((entry) => (omit[entry.to] && entry.kind === "test-lanes" ? { ...entry, omit: [...entry.omit, ...omit[entry.to]] } : entry)), ...entries];
	if (projections.length || base.submoduleProjections) merged.submoduleProjections = [...(base.submoduleProjections ?? []), ...projections];
	return merged;
}

/**
 * Loads an export manifest and its fragment from beside `manifestPath`. `root` is the tree it describes;
 * `relativePath` is the manifest path inside that tree.
 */
function loadExportManifest(manifestPath, { root, relativePath } = {}) {
	const fragmentFile = fragmentPath(manifestPath);
	const base = readJson(manifestPath);
	const fragment = readFragment(manifestPath);
	const rel = relativePath ?? (root ? display(manifestPath, root) : undefined);
	const fragmentSources = rel ? [fragmentPath(rel)] : [];
	for (const entry of [...(base.entries ?? []), ...(fragment?.entries ?? [])]) {
		if (entry.kind === "test-lanes" && typeof entry.from === "string" && entry.from.endsWith(".json")) fragmentSources.push(fragmentPath(entry.from));
	}
	const names = [display(manifestPath, root), display(fragmentFile, root)];
	const manifest = mergeExportManifest(base, fragment, { names, root, fragmentSources });
	return { manifest, base, fragment, names, text: `${JSON.stringify(manifest, null, 2)}\n` };
}

/** The merged test lanes. `names` labels the two files in errors. */
function mergeTestLanes(base, fragment, { names = ["base", "fragment"] } = {}) {
	const [baseName, fragmentName] = names;
	if (fragment === undefined) return base;
	checkKeys(fragment, LANES_KEYS, fragmentName);
	if (fragment.version !== 1) throw new Error(`${fragmentName} needs version 1`);
	const lanes = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
	const lists = () => Object.keys(lanes).filter((key) => Array.isArray(lanes[key]));
	for (const name of stringList(fragment.retire, `${fragmentName} retire`)) {
		const owners = lists().filter((key) => lanes[key].includes(name));
		if (owners.length !== 1) throw new Error(`${fragmentName} retires ${name}, which ${owners.length ? "more than one lane" : "no lane"} in ${baseName} names`);
		lanes[owners[0]] = lanes[owners[0]].filter((row) => row !== name);
	}
	const insert = fragment.insert ?? {};
	for (const [lane, groups] of Object.entries(insert)) {
		if (!Array.isArray(lanes[lane])) throw new Error(`${fragmentName} inserts into ${lane}, which is no lane in ${baseName}`);
		if (!Array.isArray(groups)) throw new Error(`${fragmentName} insert.${lane} must be an array of groups`);
		for (const { after, files } of groups) {
			const at = after === null ? 0 : lanes[lane].indexOf(after) + 1;
			if (after !== null && at === 0) throw new Error(`${fragmentName} inserts after ${after}, which ${lane} in ${baseName} does not name`);
			for (const [index, file] of stringList(files, `${fragmentName} insert.${lane} files`).entries()) {
				if (files.indexOf(file) !== index) throw new Error(`${file} is twice in one insert group for ${lane} in ${fragmentName}; keep one row`);
				const owner = lists().find((key) => lanes[key].includes(file));
				if (owner) throw new Error(`${file} is in ${owner} in ${baseName} and in ${lane} in ${fragmentName}; keep one row`);
			}
			lanes[lane].splice(at, 0, ...files);
		}
	}
	if (fragment.costs !== undefined) {
		if (!Array.isArray(fragment.costs)) throw new Error(`${fragmentName} costs must be an array of groups`);
		let entries = Object.entries(lanes.costs ?? {});
		for (const { after, costs } of fragment.costs) {
			const at = after === null ? 0 : entries.findIndex(([name]) => name === after) + 1;
			if (after !== null && at === 0) throw new Error(`${fragmentName} places costs after ${after}, which the costs in ${baseName} do not name`);
			for (const name of Object.keys(costs ?? {})) {
				if (entries.some(([other]) => other === name)) throw new Error(`${name} has a cost in both ${baseName} and ${fragmentName}`);
			}
			entries = [...entries.slice(0, at), ...Object.entries(costs ?? {}), ...entries.slice(at)];
		}
		lanes.costs = Object.fromEntries(entries);
	}
	return lanes;
}

/** Loads a test-lanes file and its fragment from beside `lanesPath`. `root` shortens the file names in errors. */
function loadTestLanes(lanesPath, { root } = {}) {
	const base = readJson(lanesPath);
	const fragment = readFragment(lanesPath);
	const names = [display(lanesPath, root), display(fragmentPath(lanesPath), root)];
	return { lanes: mergeTestLanes(base, fragment, { names }), base, fragment, names };
}

/**
 * Where AmPi test registration writes in the checkout at `repoRoot`, and the fix hints that name it. With both durable
 * fragments present, `--register` writes the fragments, and `--shared` writes the shared files.
 */
function ampiRegistration(repoRoot) {
	const lanes = path.join(repoRoot, "apps/ampi/test-lanes.json"), manifest = path.join(repoRoot, "release/public/export-manifest.json");
	const present = [lanes, manifest].map((file) => fs.existsSync(fragmentPath(file)));
	if (present[0] !== present[1]) throw new Error(`the ${LINE} line needs both apps/ampi/test-lanes.${LINE}.json and release/public/export-manifest.${LINE}.json, or neither`);
	const fragments = present[0];
	return {
		fragments,
		lanesFile: fragments ? `apps/ampi/test-lanes.${LINE}.json` : "apps/ampi/test-lanes.json",
		manifestFile: fragments ? `release/public/export-manifest.${LINE}.json` : "release/public/export-manifest.json",
		command: (file, lane = "fast") => `node apps/ampi/scripts/verify-test-lanes.cjs --register ${JSON.stringify(file)} ${lane}${fragments ? ` (writes the ${LINE} fragments; add --shared for a test that main also has)` : ""}`,
		omitList: fragments ? `the omit list for apps/ampi/test-lanes.json in release/public/export-manifest.${LINE}.json` : "the omit list of the test-lanes export entry in release/public/export-manifest.json",
	};
}

module.exports = { LINE, ampiRegistration, fragmentPath, loadExportManifest, loadTestLanes, mergeExportManifest, mergeTestLanes };
