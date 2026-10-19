// Needs-you candidates: the explicit owner asks in agent stops, found by a fixed rule with no model call. The model
// only groups candidates into asks and cites the owner entry that answers one; it never adds or silently drops one.
// The rule is ask rule v2 from the ctx-skim-3 study (apps/ampi/docs/two-tier-context.md#needs-you-candidates), plus
// the offer and handed-over phrasings that its hold-out missed.

import type { RarebitItem } from "./rarebit.ts";

const ASK_PHRASES = [
	/\bDecision needed\b/i, /\bShould I\b/i, /\bTell me if\b/i, /\bDo you want\b/i, /\bMay I\b/i, /\bStill open for you\b/i,
	/\bneeds? your (decision|approval|go|call|yes)\b/i, /\bwaiting for you to\b/i, /\bwaits? for your\b/i, /\b(is|are) with the owner\b/i,
	/\bPick one\b/i, /\byour call\b/i, /\buntil you tell me\b/i, /\bTo unblock it\b/i,
	// An offer that waits for the owner's word: "Say the word", "I can … if you want", "if you'd like, I will …".
	/\bSay the word\b/i, /\bI (can|could|will|'ll|would)\b[^.?!]*\bif you (want|like|prefer|wish|would like|'d like)\b/i,
	/\bif you (want|like|prefer|wish|would like|'d like)\b[^.?!]*\bI (can|could|will|'ll)\b/i,
	// A decision handed to the owner: "yours to decide", "up to you to choose", "the call is yours".
	/\b(yours|up to you) to (decide|choose|call|pick)\b/i, /\bthe (call|decision|choice) is yours\b/i,
];
/** A heading that opens an owner ask list; every question or list item from it to the next heading is a candidate. */
const FOR_YOU = /^(#+\s*|\*\*)?(Decisions? for you|Still open for you|Open for you|Questions? for you|For you)\b/i;
/** A Markdown heading or a line that is only bold text; it ends a for-you section. */
const HEADING = /^(#{1,6}\s+\S|\*\*[^*]+\*\*:?\s*$)/;

/** Character spans [start, end) of the for-you sections in a message. */
function forYouSections(text: string): [number, number][] {
	const spans: [number, number][] = [];
	let open: number | null = null, at = 0;
	for (const line of text.split("\n")) {
		const head = line.trim();
		if (FOR_YOU.test(head)) { if (open === null) open = at; }
		else if (open !== null && HEADING.test(head)) { spans.push([open, at]); open = null; }
		at += line.length + 1;
	}
	if (open !== null) spans.push([open, text.length]);
	return spans;
}

/** One Needs-you candidate. A restated ask keeps its ID; `entryId` and `text` follow its latest statement. */
export type AskCandidate = { id: string; text: string; entryId: string; position: number; entries: string[] };

/** Sentences and list items of a message, with their paragraph index; code fences and table rows are skipped. */
export function askUnits(text: string): { para: number; paras: number; text: string }[] {
	const paras = text.trim().split(/\n\s*\n/).filter((p) => p.trim());
	const out: { para: number; paras: number; text: string }[] = [];
	paras.forEach((p, para) => {
		for (const raw of p.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("```") || line.startsWith("|")) continue;
			// Split after a sentence end (also "?**"), never after a bare list number such as "3.".
			const merged: string[] = [];
			for (const s of line.split(/(?:(?<=[.?!])|(?<=\?\*\*))\s+(?=[A-Z*(`"])/)) {
				if (merged.length && /^(\d{1,2}\.|-)$/.test(merged.at(-1)!.trim())) merged[merged.length - 1] += ` ${s}`;
				else merged.push(s);
			}
			for (const s of merged) if (s.trim()) out.push({ para, paras: paras.length, text: s.trim() });
		}
	});
	return out;
}

/** The explicit owner asks in one agent stop: ask phrases, questions in the last paragraph, and items under a for-you heading. */
export function askSentences(text: string): string[] {
	const sections = forYouSections(text);
	const found: string[] = [];
	let pos = 0;
	for (const u of askUnits(text)) {
		const at = text.indexOf(u.text.slice(0, 40), pos);
		if (at >= 0) pos = at;
		const inSection = sections.some(([start, end]) => pos >= start && pos < end);
		const question = /\?(\*\*|_|`)*$/.test(u.text);
		if (ASK_PHRASES.some((p) => p.test(u.text)) || (question && (u.para === u.paras - 1 || inSection)) || (inSection && /^(\d+\.|-)\s/.test(u.text))) found.push(u.text);
	}
	return found;
}

/**
 * First lines of user messages that extensions send through Pi's sendUserMessage. Pi 1.3.0 stores such a message as a
 * plain user message with no source field, so text is the only signal. Injections that Pi stores as `custom_message`
 * entries never reach here: the reader marks them injected and the hub drops them from the Rarebit user items.
 */
export const INJECTED_USER_MESSAGES: { source: string; first: RegExp }[] = [
	{ source: "hc-rarebit recall", first: /^# Rarebit Recall\s*$/ },
	{ source: "plannotator annotations", first: /^# (Message|Markdown) Annotations\s*$/ },
	{ source: "pi-intercom wake", first: /^New intercom message above\.?\s*$/ },
	{ source: "team inbox wake", first: /^I have \d+ new messages?(\(s\))? in my inbox\b/ },
	{ source: "team restart recovery", first: /^Restart recovery: call read_inbox\b/ },
	{ source: "Pi Team Bright event notice", first: /^ptb\.[a-z][\w-]*:\s/ },
];

/**
 * A user message is an owner turn unless a harness injected it, or it is a relayed message whose "[...]" header does
 * not name the owner.
 */
export function isOwnerTurn(item: Pick<RarebitItem, "kind" | "text">): boolean {
	if (item.kind !== "user") return false;
	const head = item.text.trimStart(), close = head.slice(0, 200).indexOf("]");
	const first = head.split("\n", 1)[0]!.trim();
	if (INJECTED_USER_MESSAGES.some((i) => i.first.test(first))) return false;
	return !(head.startsWith("[") && close > 0) || head.slice(0, close).toLowerCase().includes("owner");
}

/** Whitespace-, case- and emphasis-insensitive form for comparing asks and quotes. */
export const normalizeText = (s: string) => s.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Every candidate in the Session's Rarebit items, oldest first. A later stop that restates an ask (same normalized
 * sentence) carries it forward: the candidate moves to the latest statement, whatever owner turns came between.
 * `owners` maps each owner turn to its position, so an answer can be checked to follow the ask it answers.
 */
export function askCandidates(items: RarebitItem[]): { candidates: AskCandidate[]; owners: Map<string, number> } {
	const byText = new Map<string, AskCandidate>(), owners = new Map<string, number>();
	items.forEach((item, position) => {
		if (isOwnerTurn(item)) owners.set(item.id, position);
		if (item.kind !== "stop") return;
		for (const text of askSentences(item.text)) {
			const key = normalizeText(text), seen = byText.get(key);
			if (seen) { if (seen.entryId !== item.id) Object.assign(seen, { text, entryId: item.id, position, entries: [...seen.entries, item.id] }); }
			else byText.set(key, { id: `q${byText.size + 1}`, text, entryId: item.id, position, entries: [item.id] });
		}
	});
	return { candidates: [...byText.values()], owners };
}
