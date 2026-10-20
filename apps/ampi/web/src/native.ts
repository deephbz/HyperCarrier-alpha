// The macOS shell's message bridge (AmPi.app's WKScriptMessageHandler "ampi"). Side-effect free: modules that render
// on the server (tests) import it, so nothing here may touch `window` at load time.

export type Native = { postMessage(message: unknown): void };

/** The bridge in AmPi.app; undefined in a browser or outside a page. */
export function native(): Native | undefined {
	if (typeof window === "undefined") return undefined;
	return (window as unknown as { webkit?: { messageHandlers?: { ampi?: Native } } }).webkit?.messageHandlers?.ampi;
}
