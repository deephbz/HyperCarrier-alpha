import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "../../../src/pi/search.ts";
import { hub, type HostState } from "../client.ts";
import { findSteps, navigate } from "../nav.ts";
import { href } from "../util.ts";

export function SessionFind({ host, threadId, onClose, onGo }: { host: string; threadId: string; onClose: () => void; onGo?: () => void }) {
 const [query, setQuery] = useState("");
 const [result, setResult] = useState<SearchResult>();
 const [error, setError] = useState("");
 const [busy, setBusy] = useState(false);
 const generation = useRef(0);
 // One Find session per open bar: its first match jump is a history step, later ones replace it (D20).
 const step = useRef(findSteps()).current;
 const go = (e: React.MouseEvent<HTMLAnchorElement>) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute("href")!, step());
  onGo?.();
 };
 useEffect(() => { generation.current++; setResult(undefined); setError(""); setBusy(false); }, [host, threadId]);
 const run = async () => {
  const token = ++generation.current; setBusy(true); setError(""); setResult(undefined);
  try { const result = await hub.request(host, "thread.find", { threadId, query }); if (generation.current === token) setResult(result); }
  catch (e) { if (generation.current === token) setError(String(e)); }
  finally { if (generation.current === token) setBusy(false); }
 };
 // Esc anywhere in the bar (input or a result link) closes it (focus R18).
 return <section className="session-find quiet-scroll" aria-label="Find in this Session" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }} style={{ padding: 8, maxHeight: "35vh", overflowY: "auto" }}>
  <form onSubmit={(e) => { e.preventDefault(); void run(); }}><input autoFocus aria-label="Find in Session" placeholder="Find in this Session, including tools…" value={query} maxLength={500} onChange={(e) => setQuery(e.target.value)} /><button className="btn small" disabled={busy || !query.trim()}>{busy ? "Scanning…" : "Find"}</button><button type="button" className="btn small" onClick={onClose}>Close</button></form>
  <p className="hint">Copied active branch · text, thinking and tools · case-insensitive substring · no images or inactive branches</p>
  {error && <p role="alert">{error}</p>}
  {result && <><p role="status">{result.total} matching entries · {result.scanned} scanned{result.more ? " · first 200 shown" : ""}{result.invalidLines ? ` · ${result.invalidLines} invalid lines excluded` : ""}</p>
   {result.hits.map((hit) => <p key={hit.entry}><a href={href.thread(host, threadId, { entry: hit.entry })} onClick={go}>{hit.snippet || hit.entry}</a><small className="hint"> · {hit.kind} · this copied branch</small></p>)}
   <p className="hint">{result.scope}</p></>}
 </section>;
}

export function FleetSearch({ hosts }: { hosts: HostState[] }) {
 const [query, setQuery] = useState("");
 const [busy, setBusy] = useState(false);
 const [results, setResults] = useState<{ host: HostState; value?: SearchResult; error?: string }[]>([]);
 const run = async () => {
  setBusy(true); setResults([]);
  const rows = await Promise.all(hosts.map(async (host) => {
   try { return { host, value: await hub.request(host.id, "sessions.search", { query }) }; }
   catch (e) { return { host, error: String(e) }; }
  }));
  setResults(rows); setBusy(false);
 };
 return <details className="fleet-search quiet-scroll" style={{ padding: "4px 8px", maxHeight: "45vh", overflowY: "auto" }}>
  <summary>Search copied prose</summary>
  <form onSubmit={(e) => { e.preventDefault(); void run(); }}><input className="search" aria-label="Search copied prose" placeholder="Words or 2+ CJK characters…" value={query} maxLength={500} onChange={(e) => setQuery(e.target.value)} /><button className="btn small" disabled={busy || !query.trim()}>{busy ? "Searching…" : "Search"}</button></form>
  <p className="hint">Retained Pi copies · human turns, replies and compaction · excludes thinking and tools. Older history: K5 tools (not full-transcript search).</p>
  {results.map(({ host, value, error }) => <section key={host.id}><strong>{host.label}</strong><span className="hint"> · {host.status === "connected" ? "copied evidence" : "Host away · last copy"}</span>
   {error && <p role="alert">Not searched: {error}</p>}
   {value && <><p role="status">{value.hits.length} results{value.more ? " · limit reached; narrow the query" : ""}{value.asOf ? ` · indexed ${new Date(value.asOf).toLocaleString()}` : ""}</p>
    {value.coverage && <p className="hint">{value.coverage.indexed} indexed copies · {value.coverage.notIndexed} not indexed · {value.coverage.stale} behind source or unavailable · {value.coverage.invalidLines} invalid records excluded</p>}
    {value.hits.map((hit) => <p key={hit.ref}><a href={href.thread(host.id, hit.threadId, { entry: hit.entry })}>{hit.title}<br />{hit.snippet}</a><small className="hint"> · prose in retained copies · tools/thinking excluded</small></p>)}
    <p className="hint">{value.scope}</p></>}
  </section>)}
 </details>;
}
