import { Marked } from "marked";
import { memo, useMemo } from "react";

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Model output is untrusted: raw HTML renders as text, and only http(s)/mailto links survive.
const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html({ text }) {
			return escape(text);
		},
		link({ href, text }) {
			const safe = /^(https?:|mailto:)/i.test(href) ? href : "#";
			return `<a href="${escape(safe)}" target="_blank" rel="noreferrer">${text}</a>`;
		},
		image({ text }) {
			return escape(`[image: ${text}]`);
		},
	},
});

// Parsed HTML outlives the component: returning to a Session reuses it instead of parsing again (latency budget, D15).
const cache = new Map<string, string>();
const CACHE_LIMIT = 4000;
function render(text: string): string {
	let html = cache.get(text);
	if (html === undefined) {
		html = marked.parse(text, { async: false }) as string;
		if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
		cache.set(text, html);
	}
	return html;
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
	const html = useMemo(() => render(text), [text]);
	return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
