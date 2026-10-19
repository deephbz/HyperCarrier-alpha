// What one extension message row shows. Pi projects every injected message as `custom` with its kind and text only,
// so the sender and the first line are read from the text each extension writes. wire-projection-shapes moves this
// into a typed union on the hub (docs/wire-boundary.md, design 4).

/** One extension message as its row shows it: kind badge, sender when known, first line, and the parts to read. */
export type NoticeView = { kind: string; alert: boolean; sender?: string; first: string; parts: { from?: string; text: string }[] };

const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

const unquote = (s: string) => {
	try {
		return JSON.parse(`"${s.replace(/\\+$/, (tail) => (tail.length % 2 ? tail.slice(1) : tail))}"`) as string;
	} catch {
		return s;
	}
};

/** The messages of a Pi Team Bright delivery: a preamble line, then `{ messages: [{ from, content }] }`. A shortened text still yields its first message. */
function deliveredMessages(text: string): { from?: string; text: string }[] {
	const start = text.indexOf("{");
	if (start < 0) return [];
	try {
		const { messages } = JSON.parse(text.slice(start)) as { messages?: { from?: unknown; content?: unknown }[] };
		if (Array.isArray(messages)) return messages.map((m) => ({ from: typeof m.from === "string" ? m.from : undefined, text: String(m.content ?? "") }));
	} catch {}
	const from = /"from":\s*"((?:[^"\\]|\\.)*)"/.exec(text), content = /"content":\s*"((?:[^"\\]|\\.)*)/.exec(text);
	return content ? [{ from: from ? unquote(from[1]!) : undefined, text: unquote(content[1]!) }] : [];
}

export function noticeView(entryKind: string, text: string): NoticeView {
	if (entryKind === "intercom_message") {
		const head = /^\*\*From (.+?)\*\*[^\n]*\n+(?:_[^\n]*_\n+)?/.exec(text);
		const body = head ? text.slice(head[0].length) : text;
		return { kind: "intercom", alert: false, sender: head?.[1], first: firstLine(body), parts: [{ text: body }] };
	}
	if (entryKind.startsWith("pi-team-bright.")) {
		const messages = deliveredMessages(text);
		if (messages.length) {
			const alert = /^\[PiTeams [^\]]*Alert\b/.test(messages[0]!.text);
			const senders = [...new Set(messages.flatMap((m) => (m.from ? [m.from] : [])))];
			return { kind: alert ? "alert" : entryKind.slice("pi-team-bright.".length).replaceAll("-", " "), alert, sender: senders.join(", ") || undefined, first: firstLine(messages[0]!.text), parts: messages };
		}
	}
	if (entryKind.startsWith("auto-compact.")) return { kind: entryKind.slice("auto-compact.".length), alert: false, sender: "Auto Compact", first: firstLine(text), parts: [{ text }] };
	return { kind: entryKind, alert: entryKind.includes("alert"), first: firstLine(text), parts: [{ text }] };
}
