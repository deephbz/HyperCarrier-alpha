// Composer submission keys also supply the help rows and busy hint.
export const COMPOSER_KEYS = [
	{ key: "Enter", help: "Send, or steer while the agent works", whenBusy: "steer" },
	{ key: "Alt+Enter", help: "Queue a follow-up", whenBusy: "followUp" },
	{ key: "Shift+Enter", help: "New line", whenBusy: null },
] as const;

export const COMPOSER_SHORTCUTS: [string, string][] = COMPOSER_KEYS.map(({ key, help }) => [key, help]);
export const COMPOSER_BUSY_HINT = `Steer now (${COMPOSER_KEYS[0].key}) or queue a follow-up (${COMPOSER_KEYS[1].key}). Esc interrupts.`;

/**
 * Send authority: a key sends only on a fresh press, which starts in the field that sends. A held key auto-repeats
 * into whichever field focus reaches, so an action that moves focus on keydown (Restore, a quote, a palette command)
 * would otherwise hand the rest of its press to that field. Every field that sends on a key asks this first.
 */
export const freshPress = (event: { repeat: boolean; isComposing: boolean }) => !event.repeat && !event.isComposing;

/** The Composer's submission for a key; `held` is a submission key that auto-repeats, which the Composer consumes. */
export function composerSubmission(event: { key: string; altKey: boolean; shiftKey: boolean; repeat: boolean; isComposing: boolean }): "steer" | "followUp" | "held" | null {
	if (event.isComposing || event.shiftKey) return null;
	const key = `${event.altKey ? "Alt+" : ""}${event.key}`;
	const whenBusy = COMPOSER_KEYS.find((binding) => binding.key === key)?.whenBusy ?? null;
	return whenBusy && !freshPress(event) ? "held" : whenBusy;
}
