// Composer submission keys also supply the help rows and busy hint.
export const COMPOSER_KEYS = [
	{ key: "Enter", help: "Send, or steer while the agent works", whenBusy: "steer" },
	{ key: "Alt+Enter", help: "Queue a follow-up", whenBusy: "followUp" },
	{ key: "Shift+Enter", help: "New line", whenBusy: null },
] as const;

export const COMPOSER_SHORTCUTS: [string, string][] = COMPOSER_KEYS.map(({ key, help }) => [key, help]);
export const COMPOSER_BUSY_HINT = `Steer now (${COMPOSER_KEYS[0].key}) or queue a follow-up (${COMPOSER_KEYS[1].key}). Esc interrupts.`;

export function composerSubmission(event: { key: string; altKey: boolean; shiftKey: boolean; isComposing: boolean }): "steer" | "followUp" | null {
	if (event.isComposing || event.shiftKey) return null;
	const key = `${event.altKey ? "Alt+" : ""}${event.key}`;
	return COMPOSER_KEYS.find((binding) => binding.key === key)?.whenBusy ?? null;
}
