import { newId } from "./ids.ts";
export type DraftImage = { data: string; mimeType: string; name: string };
/**
 * How a submission went out: its busy mode and the request that carried it. A draft carries it only while its key
 * names a send with an unknown outcome, so a retry repeats the same request under the same key.
 */
export type SendIntent = {
	whenBusy: "followUp" | "steer";
	// `asText`: the owner chose to send slash text as a message (protocol.ts thread.submit).
	route?: { kind: "message"; content: string; asText?: true } | { kind: "command"; name: string; args: string; abort?: boolean };
};
/**
 * Why a submission came back. `uncertain`: no reply proves a refusal, so it may already have arrived. `text` is the
 * owner's sentence. `once` is the retry promise of an uncertain outcome; it holds only while the payload keeps the key
 * and intent it went out under, so the presenter derives it from the current identity (`outcomeText`).
 */
export type Outcome = { uncertain: boolean; text: string; once?: string };
/**
 * The outcome of recovered text in the draft, until a send or a dismiss. A refusal ends when `text` leaves the
 * draft; an uncertain send stays uncertain whatever the owner types. `key` is the draft key the text came back under.
 */
export type DraftNotice = { id: string; text: string; key: string; outcome: Outcome };

/** What a draft says about an uncertain send once its key is gone: an edit, a merge, or a fork. */
export const MAYBE_SENT = "This message may already be in the history; check before you send.";

/** The owner's sentence for an outcome. `keyed`: the payload still holds the key and intent it went out under. */
export function outcomeText(outcome: Outcome, keyed: boolean): string {
	return outcome.once ? `${outcome.text} ${keyed ? outcome.once : MAYBE_SENT}` : outcome.text;
}

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
 * A key is a retry identity only while `intent` is set: the send under it has an unknown outcome. Any change to the
 * payload (text or images) gives the draft a new key and drops the intent, so an edited message is a new message.
 *
 * Outcome: every submission that comes back carries one `Outcome`, in every placement. A held record keeps it; a
 * give-back or a restore into the draft keeps it as a notice on that text. The Composer presents only this value, so a
 * placement or a navigation cannot turn an uncertain outcome into a refusal. The key follows the outcome: only an
 * uncertain outcome keeps the submission's key and intent.
 */
export type Draft<I> = { text: string; images: I[]; key: string; intent?: SendIntent };
export type Returned<I> = Draft<I> & { id: string; outcome: Outcome };
/** `notices` warn about recovered text in the draft; `commandResult` is the answer to the last command sent. */
export type Custody<I> = { draft: Draft<I>; returned: Returned<I>[]; notices?: DraftNotice[]; commandResult?: { id: string; notice?: string; body?: string } };

export const isEmpty = (draft: Draft<unknown>) => !draft.text.trim() && draft.images.length === 0;

/** A notice keeps its retry promise only while the draft holds the key and intent the text came back under. */
export const noticeKeyed = (draft: Draft<unknown>, notice: DraftNotice) => !!draft.intent && draft.key === notice.key;

/** The submission and the custody after it: an empty draft under `nextKey`. Notices end with the text they name. */
export function takeDraft<I>(custody: Custody<I>, nextKey: string): [Custody<I>, Draft<I>] {
	const { notices: _sent, ...rest } = custody;
	return [{ ...rest, draft: { text: "", images: [], key: nextKey } }, custody.draft];
}

/**
 * An uncertain `outcome` keeps the submission's key and intent, so a retry is placed at most once. Otherwise the
 * submission comes back under a new key, as a new message.
 * `hold`: keep it beside the draft even when the draft is empty, e.g. when the owner is not looking at this Session.
 * `quiet`: a give-back into the draft leaves no notice, because the caller states the outcome itself (a choice).
 */
export function giveBack<I>(custody: Custody<I>, submission: Draft<I>, { id, outcome, newKey, hold = false, quiet = false }: { id: string; outcome: Outcome; newKey: () => string; hold?: boolean; quiet?: boolean }): Custody<I> {
	const back: Draft<I> = outcome.uncertain ? submission : { text: submission.text, images: submission.images, key: newKey() };
	if (!hold && isEmpty(custody.draft)) return { ...custody, draft: back, ...(quiet ? {} : { notices: [...(custody.notices ?? []), { id, text: back.text, key: back.key, outcome }] }) };
	return { ...custody, returned: [...custody.returned, { ...back, id, outcome }] };
}

/**
 * Moves a returned message into the draft, text first; images the draft cannot admit stay held in the record. The
 * message keeps its key and intent only when it lands whole in an empty draft; any other result is a new payload. The
 * moved text keeps the record's outcome as a notice.
 */
export function restoreReturned<I>(custody: Custody<I>, id: string, admit: (current: readonly I[], incoming: readonly I[]) => { accepted: I[]; rejected: I[] }, newKey: () => string): Custody<I> {
	const record = custody.returned.find((r) => r.id === id);
	if (!record) return custody;
	const { accepted, rejected } = admit(custody.draft.images, record.images);
	const rest = custody.returned.filter((r) => r !== record);
	const notices = [...(custody.notices ?? []), { id: record.id, text: record.text, key: record.key, outcome: record.outcome }];
	if (isEmpty(custody.draft) && !rejected.length) return { ...custody, draft: { text: record.text, images: record.images, key: record.key, ...(record.intent ? { intent: record.intent } : {}) }, returned: rest, notices };
	const draft = { text: [record.text, custody.draft.text].filter((t) => t.trim()).join("\n\n"), images: [...custody.draft.images, ...accepted], key: newKey() };
	return { ...custody, draft, notices, returned: rejected.length ? custody.returned.map((r) => (r === record ? { id: r.id, outcome: r.outcome, text: "", images: rejected, key: newKey() } : r)) : rest };
}

/**
 * Changes the draft's payload. The first change to a draft that carries an intent gives it a new key, so the edit is
 * a new message. A refusal notice ends when its text leaves the draft. Images compare by reference, so a new array with the
 * same images also counts as a change and rekeys: a spare key costs nothing, a reused key can drop a message.
 */
export function editDraft<I>(custody: Custody<I>, change: { text?: string; images?: I[] }, newKey: () => string): Custody<I> {
	const { draft } = custody;
	const text = change.text ?? draft.text, images = change.images ?? draft.images;
	if (text === draft.text && images === draft.images) return custody;
	const next: Draft<I> = draft.intent ? { text, images, key: newKey() } : { ...draft, text, images };
	const notices = custody.notices?.filter((notice) => notice.outcome.uncertain || text.includes(notice.text));
	return { ...custody, draft: next, ...(custody.notices ? { notices } : {}) };
}

/** Adds `text` after the draft; `outcome` stays with it until the text leaves the draft. */
export function appendDraftText<I>(custody: Custody<I>, text: string, newKey: () => string, outcome?: Outcome): Custody<I> {
	const current = custody.draft.text;
	const next = editDraft(custody, { text: current ? `${current}\n\n${text}` : text }, newKey);
	return outcome ? { ...next, notices: [...(next.notices ?? []), { id: newId(), text, key: next.draft.key, outcome }] } : next;
}

/** Puts `text` ahead of the draft: returned queue text, which has no retry identity. */
export function prependDraftText<I>(custody: Custody<I>, text: string, newKey: () => string): Custody<I> {
	return editDraft(custody, { text: [text, custody.draft.text].filter((t) => t.trim()).join("\n\n") }, newKey);
}

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

export function dismissNotice<I>(custody: Custody<I>, id: string): Custody<I> {
	return { ...custody, notices: (custody.notices ?? []).filter((notice) => notice.id !== id) };
}
