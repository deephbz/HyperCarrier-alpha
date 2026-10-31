/** Quotes are free draft text; appending leaves the rest of the draft unchanged. */
export function appendDraftQuote<D extends { text: string }>(draft: D, selection: string, note: string): D {
	if (!selection.trim()) return draft;
	const quote = selection.replace(/\r\n?/g, "\n").split("\n").map((line) => "> " + line).join("\n");
	const separator = !draft.text || draft.text.endsWith("\n\n") ? "" : draft.text.endsWith("\n") ? "\n" : "\n\n";
	return { ...draft, text: draft.text + separator + quote + "\n\n" + (note.trim() ? note.trim() + "\n\n" : "") };
}

/**
 * Draft custody. A send takes the draft as an immutable submission and leaves an empty draft under a new key, so
 * each submission holds its own content and request key. A failed submission comes back by giveBack: into an empty
 * draft, or else held beside the draft until the owner restores or discards it. A late outcome never writes over a
 * newer draft.
 *
 * Outcome: every submission that comes back carries one `Outcome`, in every placement: a held record keeps it, and a
 * give-back into the draft leaves it as the draft's `notice` until the next send or until the draft is empty. The
 * Composer presents only this value, so a placement or a navigation cannot turn an uncertain outcome into a refusal.
 * The retry promise of an uncertain outcome (`once`) names one payload: it shows only while that payload keeps its
 * retry key (`outcomeText`). An edit, a merge, or a partial restore ends the promise and keeps the uncertainty.
 *
 * Keys: a request key names exactly one unchanged payload whose outcome is uncertain. Only an uncertain outcome keeps
 * its key, so the key and the shown outcome cannot disagree: a held message carries it as `retry`, a draft as its key with `retry: true`. A final
 * refusal carries no key. Any change of payload (an edit, a merge, a partial restore) takes a fresh key, so a key never
 * names two payloads. The durable node places a key at most once. Pi hosts do not deduplicate keys, so a same-key
 * retry on Pi can still be placed twice. Fresh keys come in as arguments; the module stays pure.
 */
/**
 * Why a submission came back. `uncertain`: no reply proves a refusal, so it may already have arrived. `text` is the
 * owner's sentence. `once` is the retry promise of an uncertain outcome; it holds only under the submission's key.
 */
export type Outcome = { uncertain: boolean; text: string; once?: string };
export type Draft<I> = { text: string; images: I[]; key: string; retry?: true };
export type Returned<I> = { id: string; outcome: Outcome; text: string; images: I[]; retry?: string };
export type Custody<I> = { draft: Draft<I>; returned: Returned<I>[]; notice?: Outcome };

export const isEmpty = (draft: { text: string; images: readonly unknown[] }) => !draft.text.trim() && draft.images.length === 0;

/** What an uncertain send says once its payload has a new key. */
export const MAYBE_SENT = "This message may already be in the history; check before you send.";

/** The owner's sentence for an outcome. `keyed`: the payload still holds the retry key it went out under. */
export function outcomeText(outcome: Outcome, keyed: boolean): string {
	return outcome.once ? `${outcome.text} ${keyed ? outcome.once : MAYBE_SENT}` : outcome.text;
}

/** The submission and the custody after it: an empty draft under `nextKey`, without the draft's notice. */
export function takeDraft<I>(custody: Custody<I>, nextKey: string): [Custody<I>, Draft<I>] {
	const { text, images, key } = custody.draft;
	return [{ returned: custody.returned, draft: { text: "", images: [], key: nextKey } }, { text, images, key }];
}

/**
 * Changes the draft's content. The first change of a draft that holds a retry key gives it `freshKey`. The notice ends
 * when the draft is empty.
 */
export function editDraft<I>(custody: Custody<I>, change: { text?: string; images?: I[] }, freshKey: string): Custody<I> {
	const { text = custody.draft.text, images = custody.draft.images } = change;
	if (text === custody.draft.text && images === custody.draft.images) return custody;
	const draft = { text, images, key: custody.draft.retry ? freshKey : custody.draft.key };
	return isEmpty(draft) ? { draft, returned: custody.returned } : { ...custody, draft };
}

/**
 * An uncertain `outcome` keeps the submission's key, so a retry of the unchanged submission reuses it.
 * `hold`: keep it beside the draft even when the draft is empty, e.g. when the owner is not looking at this Session.
 * `quiet`: a give-back into the draft leaves no notice, because the caller states the outcome itself (a choice).
 */
export function giveBack<I>(custody: Custody<I>, submission: Draft<I>, { id, outcome, hold = false, quiet = false }: { id: string; outcome: Outcome; hold?: boolean; quiet?: boolean }): Custody<I> {
	const { text, images, key } = submission;
	if (!hold && isEmpty(custody.draft)) {
		const draft: Draft<I> = outcome.uncertain ? { text, images, key, retry: true } : { text, images, key: custody.draft.key };
		return quiet ? { draft, returned: custody.returned } : { ...custody, draft, notice: outcome };
	}
	return { ...custody, returned: [...custody.returned, { id, outcome, text, images, ...(outcome.uncertain ? { retry: key } : {}) }] };
}

/**
 * Moves a returned message into the draft, text first; images the draft cannot admit stay held, without a key. Only an
 * unchanged message, into an empty draft with every image, keeps its retry key; any other restore takes `freshKey`. The
 * draft takes the message's outcome as its notice, unless that would replace an uncertain notice with a certain one.
 */
export function restoreReturned<I>(custody: Custody<I>, id: string, admit: (current: readonly I[], incoming: readonly I[]) => { accepted: I[]; rejected: I[] }, freshKey: string): Custody<I> {
	const record = custody.returned.find((r) => r.id === id);
	if (!record) return custody;
	const { accepted, rejected } = admit(custody.draft.images, record.images);
	const unchanged = isEmpty(custody.draft) && rejected.length === 0;
	const text = [record.text, custody.draft.text].filter((t) => t.trim()).join("\n\n");
	const images = [...custody.draft.images, ...accepted];
	const draft: Draft<I> = unchanged && record.retry ? { text, images, key: record.retry, retry: true } : { text, images, key: freshKey };
	const returned = rejected.length ? custody.returned.map((r) => (r === record ? { id: r.id, outcome: r.outcome, text: "", images: rejected } : r)) : custody.returned.filter((r) => r !== record);
	const notice = custody.notice?.uncertain && !record.outcome.uncertain ? custody.notice : record.outcome;
	return { draft, returned, notice };
}
