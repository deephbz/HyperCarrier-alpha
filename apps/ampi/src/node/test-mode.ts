// Tests and their child nodes inherit this mode. It only enables restrictions; no environment flag permits providers.
let testing = false;
export function isTestMode(): boolean {
	// Helpers can bootstrap after a source import. Once detected, test restrictions stay enabled.
	return testing ||= Boolean(process.env.NODE_TEST_CONTEXT) || process.env.AMPI_TEST_MODE === "1";
}

export function assertTestIsolation(): void {
	if (isTestMode() && (process.env.AMPI_TEST_MODE !== "1" || !process.env.HOME || !process.env.PI_CODING_AGENT_DIR))
		throw new Error("AmPi test isolation is missing. Import test/bound.ts or test/helpers.ts before loading node or Pi resources.");
}
