export type DraftImage = { data: string; mimeType: string; name: string };
export type SendIntent = {
	id: string; order: number; text: string; images: DraftImage[]; whenBusy: "followUp" | "steer";
	route?: { kind: "message"; content: string } | { kind: "command"; name: string; args: string; abort?: boolean };
};
type Span = { start: number; end: number; intent: SendIntent };
/** A warning about recovered text in the draft. It lasts while `text` stays in the draft, until a send or a dismiss. */
export type DraftNotice = { id: string; text: string; message: string };
export type ComposerDraft = { text: string; images: DraftImage[]; spans: Span[]; notices?: DraftNotice[]; commandResult?: { id: string; notice?: string; body?: string } };
export const EMPTY_DRAFT: ComposerDraft = { text: "", images: [], spans: [] };
export type DraftPart = { text: string; images: DraftImage[]; intent?: SendIntent };

export function draftParts(draft: ComposerDraft): DraftPart[] {
	const parts: DraftPart[] = [];
	let offset = 0, afterSpan = false;
	const plain = (end: number, beforeSpan = false) => {
		let text = draft.text.slice(offset, end);
		// Only the blank-line separator beside a span is structural. Keep all payload whitespace.
		if (afterSpan && text.startsWith("\n\n")) text = text.slice(2);
		if (beforeSpan && text.endsWith("\n\n")) text = text.slice(0, -2);
		if (text) parts.push({ text, images: [] });
	};
	for (const span of draft.spans) {
		plain(span.start, true);
		parts.push({ text: span.intent.text, images: span.intent.images, intent: span.intent });
		offset = span.end;
		afterSpan = true;
	}
	plain(draft.text.length);
	const owned = new Set(draft.spans.flatMap((span) => span.intent.images));
	const free = draft.images.filter((image) => !owned.has(image));
	if (free.length) {
		const part = parts.find((part) => !part.intent);
		if (part) part.images = free;
		else parts.push({ text: "", images: free });
	}
	return parts;
}

function assemble(parts: DraftPart[]): ComposerDraft {
	let text = "";
	const spans: Span[] = [];
	const images: DraftImage[] = [];
	for (const part of parts) {
		if (text && part.text) text += "\n\n";
		const start = text.length;
		text += part.text;
		if (part.intent) spans.push({ start, end: text.length, intent: part.intent });
		images.push(...part.images);
	}
	return { text, spans, images };
}

/** Late failures precede free text in original send order, independent of reply order. */
export function restoreIntents(draft: ComposerDraft, intents: SendIntent[]): ComposerDraft {
	const parts = draftParts(draft);
	const retries = new Map(parts.flatMap((part) => part.intent ? [[part.intent.id, part.intent] as const] : []));
	for (const intent of intents) if (!retries.has(intent.id)) retries.set(intent.id, intent);
	return { ...assemble([
		...[...retries.values()].sort((a, b) => a.order - b.order).map((intent) => ({ text: intent.text, images: intent.images, intent })),
		...parts.filter((part) => !part.intent),
	]), commandResult: draft.commandResult };
}

/** Returned queue text has no retry identity, even when it equals an existing span. */
export function prependDraftText(draft: ComposerDraft, text: string): ComposerDraft {
	const prefix = text + (draft.text ? "\n\n" : "");
	return { ...draft, text: prefix + draft.text, spans: draft.spans.map((span) => ({ ...span, start: span.start + prefix.length, end: span.end + prefix.length })) };
}

/** Quotes are free draft text; appending leaves retry identities and attachments unchanged. */
export function appendDraftQuote(draft: ComposerDraft, selection: string, note: string): ComposerDraft {
	if (!selection.trim()) return draft;
	const quote = selection.replace(/\r\n?/g, "\n").split("\n").map((line) => "> " + line).join("\n");
	const separator = !draft.text || draft.text.endsWith("\n\n") ? "" : draft.text.endsWith("\n") ? "\n" : "\n\n";
	return { ...draft, text: draft.text + separator + quote + "\n\n" + (note.trim() ? note.trim() + "\n\n" : "") };
}

/** Adds `text` after the draft, so the owner's text and its retry identities stay as they are; `message` warns about it. */
export function appendDraftText(draft: ComposerDraft, text: string, message?: string): ComposerDraft {
	const notices = message ? [...(draft.notices ?? []), { id: crypto.randomUUID(), text, message }] : draft.notices;
	return { ...draft, text: draft.text ? `${draft.text}\n\n${text}` : text, ...(notices ? { notices } : {}) };
}

/**
 * The draft a fork starts with, or `undefined` when the fork keeps its own draft. The text and its notices carry over;
 * retry spans stay with the source, so the fork never retries the source's sends. The source is not changed.
 */
export function carriedDraft(source: ComposerDraft | undefined, destination: ComposerDraft | undefined): ComposerDraft | undefined {
	if (!source || destination) return undefined;
	return { ...source, commandResult: undefined, spans: [], notices: (source.notices ?? []).map((notice) => ({ ...notice })) };
}

export function dismissNotice(draft: ComposerDraft, id: string): ComposerDraft {
	return { ...draft, notices: (draft.notices ?? []).filter((notice) => notice.id !== id) };
}

/** A final refusal retains the payload but removes only the refused retry identity. */
export function refuseIntent(draft: ComposerDraft, id: string): ComposerDraft {
	return { ...draft, spans: draft.spans.filter((span) => span.intent.id !== id) };
}

export function editDraftImages(draft: ComposerDraft, images: DraftImage[]): ComposerDraft {
	return { ...draft, images, spans: draft.spans.filter((span) => span.intent.images.length === 0) };
}

/** A textarea edit shifts untouched spans. An edit within a span invalidates that intent. */
export function editDraftText(draft: ComposerDraft, text: string): ComposerDraft {
	if (text === draft.text) return draft;
	let start = 0, end = draft.text.length, nextEnd = text.length;
	while (start < end && start < nextEnd && draft.text[start] === text[start]) start++;
	while (end > start && nextEnd > start && draft.text[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
	const inserted = text.slice(start, nextEnd);
	const delta = nextEnd - end;
	const spans = draft.spans.flatMap((span) => {
		if (start < span.end && end > span.start) return [];
		if (start === end) {
			if (start > span.start && start < span.end) return [];
			if (start === span.end && inserted && !inserted.startsWith("\n\n")) return [];
			if (start === span.start && inserted && !inserted.endsWith("\n\n")) return [];
		}
		return [{ ...span, start: span.start >= end ? span.start + delta : span.start, end: span.start >= end ? span.end + delta : span.end }];
	});
	// A notice ends when the owner edits its text away.
	const notices = draft.notices?.filter((notice) => text.includes(notice.text));
	return { ...draft, text, spans, ...(notices ? { notices } : {}) };
}
