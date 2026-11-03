export type DemoDataMode = "demo" | "worst" | "empty" | "one" | "huge";

const MODES = new Set<DemoDataMode>(["demo", "worst", "empty", "one", "huge"]);

/** Parse the demo-only fixture option. Production hub entry points must not import this module. */
export function demoDataMode(args: readonly string[] = []): DemoDataMode {
	let mode: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg !== "--fixture") throw new Error(`Unknown demo option ${JSON.stringify(arg)}; expected --fixture <demo|worst|empty|one|huge>`);
		if (mode !== undefined) throw new Error("Demo option --fixture may appear only once");
		mode = args[++i];
		if (mode === undefined || mode.startsWith("--")) throw new Error("Demo option --fixture requires a value");
	}
	if (mode === undefined || mode === "") return "demo";
	if (MODES.has(mode as DemoDataMode)) return mode as DemoDataMode;
	throw new Error(`Unknown demo fixture ${JSON.stringify(mode)}; expected demo, worst, empty, one, or huge`);
}
