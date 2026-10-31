// Composer submission keys also supply the help rows and busy hint.
export const COMPOSER_KEYS = [
	{ key: "Enter", help: "Send, or steer while the agent works", whenBusy: "steer" },
	{ key: "Alt+Enter", help: "Queue a follow-up", whenBusy: "followUp" },
	{ key: "Shift+Enter", help: "New line", whenBusy: null },
] as const;

export const COMPOSER_SHORTCUTS: [string, string][] = COMPOSER_KEYS.map(({ key, help }) => [key, help]);
export const COMPOSER_BUSY_HINT = `Steer now (${COMPOSER_KEYS[0].key}) or queue a follow-up (${COMPOSER_KEYS[1].key}). Esc interrupts.`;

/**
 * The empty composer's hint. `touch`: the touch field rule applies (styles.css sets --touch-fields), so the field
 * renders at 16 px or more and the hint is a short one that fits one line on a 375 px phone. A desktop keeps the full
 * hint. `control`: a Pi Session with a control socket; `images`: the Session takes images.
 */
export function composerHint({ busy, pi, control, images, touch }: { busy: boolean; pi: boolean; control: boolean; images: boolean; touch: boolean }): string {
	// A phone keyboard has no Alt, so the touch busy hint names Enter only; the Queue button shows beside the composer.
	if (busy) return touch ? `Message · ${COMPOSER_KEYS[0].key} steers` : COMPOSER_BUSY_HINT;
	if (!pi) return touch ? "Message · Enter sends" : "Message the agent… (Enter sends, Shift+Enter adds a line, / for commands, paste or drop images)";
	if (control) return touch ? "Message · Enter starts a turn" : `Message the agent… (Enter starts a turn, Shift+Enter adds a line, / for commands${images ? ", paste or drop images" : ""})`;
	return touch ? "Message · Enter types in Herdr" : "Message the agent… (Enter types it into the Herdr pane, Shift+Enter adds a line)";
}

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
