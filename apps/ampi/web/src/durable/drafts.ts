// Durable draft carry: a fork of a closed thread continues its source's unsent draft (thread-surface.tsx, carryDraft).
// Also the durable composer's idle hint (composer-surface.tsx). Pure, so node tests read it.

import { type Custody, MAYBE_SENT, isEmpty, noticeKeyed } from "../composer-drafts.ts";
import type { HintState } from "../composer-keys.ts";
import { newId } from "../ids.ts";

/**
 * The custody a fork starts with, or `undefined` when the fork keeps its own. The draft's text, images, and notices
 * carry over under a new key; held messages and retry intents stay with the source, so the fork never retries the
 * source's sends. A draft with an intent may already be in the source's history, so the fork warns about it once: a
 * carried notice on that send already says so, because the new key ends its retry promise. The source is not changed.
 */
export function carriedDraft<I>(source: Custody<I> | undefined, destination: Custody<I> | undefined, newKey: () => string): Custody<I> | undefined {
	if (!source || isEmpty(source.draft)) return undefined;
	if (destination && (!isEmpty(destination.draft) || destination.returned.length)) return undefined;
	const notices = (source.notices ?? []).map((notice) => ({ ...notice }));
	const key = newKey();
	const stated = notices.some((notice) => noticeKeyed(source.draft, notice) && notice.outcome.once);
	if (source.draft.intent && !stated) notices.push({ id: newId(), text: source.draft.text, key, outcome: { uncertain: true, text: MAYBE_SENT } });
	return { draft: { text: source.draft.text, images: [...source.draft.images], key }, returned: [], ...(notices.length ? { notices } : {}) };
}


/** The durable composer's idle hint: the node sends, and takes slash commands and images. */
export const durableHint = ({ touch }: HintState): string => (touch ? "Message · Enter sends" : "Message the agent… (Enter sends, Shift+Enter adds a line, / for commands, paste or drop images)");
