import { type ReactNode, useState } from "react";
import type { PiEntry } from "../../../src/shared/protocol.ts";
import { hub, readVersioned } from "../client.ts";

/** "Output shortened · 9 KB": what a card's preview cut, and the source size when known. */
export const shortenedLabel = (what: string, bytes?: number) => bytes ? `${what} shortened · ${Math.max(1, Math.round(bytes / 1024))} KB` : `${what} shortened`;

/**
 * The full projected entry, joined from its pages of one version. The hub sends only its allowed keys, never the native
 * record. A Session that changes during the read restarts it at its newest version, after indexing has had a moment.
 */
export async function fetchEntry(host: string, threadId: string, entry: string): Promise<PiEntry> {
 return readVersioned(async () => {
  let text = "", offset = 0, version: string | undefined, page;
  do {
   page = await hub.request(host, "thread.entry", { threadId, entry, offset, version });
   text += page.text; offset = page.next; version = page.version;
  } while (page.more);
  return JSON.parse(text) as PiEntry;
 }, undefined, () => new Promise((done) => setTimeout(() => done(undefined), 250)));
}

/** A card's shortened part, read in full on open. `show` draws that part of the full entry. */
export function EntryBody({ host, threadId, entry, label = "Preview shortened", show }: { host: string; threadId: string; entry: string; label?: string; show: (entry: PiEntry) => ReactNode }) {
 const [full, setFull] = useState<PiEntry>();
 const [error, setError] = useState("");
 const [busy, setBusy] = useState(false);
 const load = async () => {
  setBusy(true); setError("");
  try { setFull(await fetchEntry(host, threadId, entry)); }
  catch (e) { setError((e as Error).message ?? String(e)); }
  finally { setBusy(false); }
 };
 return <details className="entry-body" onToggle={(e) => { if (e.currentTarget.open && !full && !busy) void load(); if (!e.currentTarget.open) setFull(undefined); }}>
  <summary className="disclosure">{label} · Read source entry</summary>
  {error && <p role="alert">{error}</p>}
  {full && show(full)}
  {busy && <span role="status">Reading entry…</span>}
 </details>;
}
