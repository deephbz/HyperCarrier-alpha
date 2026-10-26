// The browser engines a test run selects. AMPI_TEST_ENGINES names them, comma separated; unset selects every engine.
// A deselected engine's cases skip with the reason "engine not selected". A selected engine whose browser is missing
// still fails: the selection is a declared choice, not a fallback. Hosted Linux CI selects chromium; the macOS job
// selects webkit, the engine AmPi.app ships.
export const ENGINE_NAMES = ["chromium", "webkit"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

function selection(value: string | undefined): Set<EngineName> {
	if (value === undefined || value.trim() === "") return new Set(ENGINE_NAMES);
	const names = value.split(",").map((name) => name.trim()).filter(Boolean);
	const unknown = names.filter((name) => !(ENGINE_NAMES as readonly string[]).includes(name));
	if (unknown.length > 0) throw new Error(`AMPI_TEST_ENGINES names unknown engines: ${unknown.join(", ")}; known: ${ENGINE_NAMES.join(", ")}`);
	return new Set(names as EngineName[]);
}

const selected = selection(process.env.AMPI_TEST_ENGINES);

/** The `skip` option for an engine's case: false when the run selects the engine. */
export function engineSkip(engine: string): string | false {
	return selected.has(engine as EngineName) ? false : "engine not selected";
}
