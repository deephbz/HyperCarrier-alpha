import { Fragment, useEffect, useState } from "react";
import { useHoverCard } from "../../components/hover-card.tsx";
import { hub } from "../../client.ts";
import { href } from "../../util.ts";
import type { Cite } from "../../../../src/shared/protocol.ts";

export type ReadMessage = (id: string) => Promise<string>;

/** Citations fetch source text only on disclosure. The receipt's quote remains visible if the source is unavailable. */
export function Citations({ cites, host, threadId, readMessage }: { cites: Cite[]; host: string; threadId: string; readMessage?: ReadMessage }) {
	return <>{cites.map((cite, i) => <Citation key={`${cite.id}-${i}`} cite={cite} host={host} threadId={threadId} readMessage={readMessage} />)}</>;
}

function Citation({ cite, host, threadId, readMessage }: { cite: Cite; host: string; threadId: string; readMessage?: ReadMessage }) {
	const { id, open, anchorProps, render } = useHoverCard<HTMLAnchorElement>();
	const [message, setMessage] = useState<string>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!open || message !== undefined) return;
		let active = true;
		const read = async () => {
			if (readMessage) return readMessage(cite.id);
			let text = "", offset = 0, version: string | undefined;
			for (;;) {
				const page = await hub.request(host, "thread.entry", { threadId, entry: cite.id, offset, version });
				text += page.text;
				if (!page.more) return text;
				offset = page.next; version = page.version;
			}
		};
		void read().then((text) => { if (active) { setMessage(text); setError(undefined); } }, (e) => { if (active) setError((e as Error).message); });
		return () => { active = false; };
	}, [open, cite.id, host, threadId, readMessage, message]);
	return <><a {...anchorProps} className="arc-cite" href={href.thread(host, threadId, { entry: cite.id, panel: "arc" })} aria-describedby={open ? id : undefined}>{cite.id.length <= 12 ? cite.id : cite.id.slice(0, 8)}</a>
		{render(`Source ${cite.id}`, <div className="arc-citation-content">
			<div className="arc-meta">{cite.id}</div>
			{message !== undefined ? <div className="arc-source">{highlight(message, cite.quote)}</div> : <><mark>{cite.quote}</mark><p className="arc-meta">{error ? `Source unavailable: ${error}` : "Reading source…"}</p></>}
		</div>)}</>;
}

function highlight(text: string, quote: string) {
	// The builder accepts quotes with whitespace and Markdown emphasis differences.
	const pattern = quote.replace(/[*_]/g, "").trim().split(/\s+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
	const plain: string[] = [], offsets: number[] = [];
	for (let i = 0; i < text.length; i++) if (!"*_".includes(text[i]!)) { plain.push(text[i]!); offsets.push(i); }
	const match = pattern ? new RegExp(pattern, "i").exec(plain.join("")) : null;
	if (!match) return <>{text}<blockquote><mark>{quote}</mark></blockquote></>;
	const start = offsets[match.index]!, end = offsets[match.index + match[0].length - 1]! + 1;
	return <Fragment>{text.slice(0, start)}<mark>{text.slice(start, end)}</mark>{text.slice(end)}</Fragment>;
}
