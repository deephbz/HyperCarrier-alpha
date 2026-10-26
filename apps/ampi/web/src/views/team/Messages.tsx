import { useState } from "react";
import type { TeamMessage, TeamMessages } from "../../../../src/shared/team-messages.ts";

type Delivery = Extract<TeamMessage, { kind: "delivery" }>;
type Row = { id: string; kind: TeamMessage["kind"]; at: number | null; from: string[]; to: string[]; message?: TeamMessage; deliveries: Delivery[] };
const kinds = { alert: "Alert", delivery: "Delivery", "lead-update": "Lead-update event" };
const time = (at: number | null | undefined) => at == null || !Number.isFinite(at) ? "Time unavailable" : new Date(at).toLocaleString([], { hour12: false });
const detail = (r?: TeamMessage) => !r ? "Alert text outside recent history" : r.kind === "alert" ? r.text : r.kind === "lead-update" ? r.text ?? r.eventKind.replaceAll("_", " ") : `${r.deliveryKind} · ${r.ref}`;
const CAVEAT = "Status does not prove reading or action. A lead-update event does not prove presentation to the lead.";
const PAGE = 30;

/** Fold only by the recorded Alert reference. Bounds can leave its authored text unavailable. */
function fold(records: TeamMessage[]): Row[] {
 const alerts = new Map<string, Row>();
 const rows: Row[] = [];
 for (const r of records) {
  if (r.kind === "delivery" && r.deliveryKind === "alert") continue;
  const row: Row = { id: r.id, kind: r.kind, at: r.at, from: r.from === null ? [] : [r.from], to: r.to, message: r, deliveries: [] };
  rows.push(row);
  if (r.kind === "alert") alerts.set(r.id, row);
 }
 for (const d of records) {
  if (d.kind !== "delivery" || d.deliveryKind !== "alert") continue;
  let row = alerts.get(d.ref);
  if (!row) {
   row = { id: d.ref, kind: "alert", at: null, from: [], to: [], deliveries: [] };
   alerts.set(d.ref, row); rows.push(row);
  }
  row.deliveries.push(d);
  if (!row.message) row.to = [...new Set([...row.to, ...d.to])];
 }
 return rows.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
}

function Status({ message }: { message: TeamMessage }) {
 const received = message.kind === "delivery" && message.deliveryKind === "alert" && message.status === "accepted";
 return <span title={CAVEAT}>{received ? "received" : message.status}</span>;
}

function DeliveryDetail({ delivery: d }: { delivery: Delivery }) {
 return <div className="ptb-delivery-detail">
  <p>{d.to.join(", ")}: <Status message={d} /> · Conversation: {d.conversationId} · Generation: {d.generation}</p>
  <p>Accepted: {time(d.acceptedAt)}{d.submittedAt !== undefined ? ` · Submitted: ${time(d.submittedAt)}` : ""}{d.settledAt !== undefined ? ` · Settled: ${time(d.settledAt)}` : ""}</p>
  {d.submissionId && <p>Submission: {d.submissionId}</p>}
  {d.outcome && <p>Recorded outcome: {d.outcome}</p>}
  <p className="ptb-id">Delivery: {d.id}</p>
 </div>;
}

export function Messages({ value }: { value: TeamMessages }) {
 const [from, setFrom] = useState(""), [to, setTo] = useState(""), [page, setPage] = useState(0), [activity, setActivity] = useState(false);
 if (value.availability === "unavailable") return <section aria-label="Messages"><p className="ptb-notice">{value.reason}</p></section>;
 const all = fold(value.records);
 const available = all.filter(r => activity || r.kind !== "lead-update");
 const senders = [...new Set(available.flatMap(r => r.from))].sort();
 const recipients = [...new Set(available.flatMap(r => r.to))].sort();
 const filtered = available.filter(r => (!from || r.from.includes(from)) && (!to || r.to.includes(to)));
 const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE) - 1));
 const rows = filtered.slice(currentPage * PAGE, (currentPage + 1) * PAGE);
 const orphans = all.filter(r => !r.message).length;
 return <section aria-label="Messages" className="ptb-messages">
  <p className="ptb-hint" role="status">Recent history: {filtered.length} of {available.length} rows · last {value.limits.alerts} Alerts, {value.limits.deliveries} deliveries, {value.limits.events} journal events{orphans > 0 ? ` · Alert texts outside history: ${orphans}` : ""}</p>
  <div className="ptb-message-filters">
   <label>From<select aria-label="Message sender" value={from} onChange={e => { setFrom(e.target.value); setPage(0); }}><option value="">All senders</option>{[...new Set([...senders, ...(from ? [from] : [])])].map(s => <option key={s} value={s}>{s}</option>)}</select></label>
   <label>To<select aria-label="Message recipient" value={to} onChange={e => { setTo(e.target.value); setPage(0); }}><option value="">All recipients</option>{[...new Set([...recipients, ...(to ? [to] : [])])].map(s => <option key={s} value={s}>{s}</option>)}</select></label>
  </div>
  <label className="ptb-activity"><input type="checkbox" checked={activity} onChange={e => {
   const checked = e.target.checked;
   if (!checked) {
    const messages = all.filter(r => r.kind !== "lead-update");
    if (!messages.some(r => r.from.includes(from))) setFrom("");
    if (!messages.some(r => r.to.includes(to))) setTo("");
   }
   setActivity(checked); setPage(0);
  }} />Show activity</label>
  {!rows.length && <p className="ptb-hint">{from || to ? "No matching messages in this recent history." : "No messages in this recent history."}</p>}
  <ol className="ptb-message-list">{rows.map(row => {
   const r = row.message;
   return <li key={JSON.stringify([value.source, value.epoch, row.kind, row.id])} data-message-kind={row.kind}>
    <details>
     <summary><span className="ptb-message-meta">{kinds[row.kind]}{r && r.kind !== "alert" ? <> · <Status message={r} /></> : null} · {time(row.at)}</span>
      <span>{row.from.join(", ") || "Sender unavailable"} → {row.to.join(", ")}</span>
      <span className="ptb-message-preview">{detail(r)}</span>
      {row.deliveries.length > 0 && <span className="ptb-delivery-status">{row.deliveries.map((d, i) => <span key={d.id}>{i > 0 ? " · " : ""}{d.to.join(", ")}: <Status message={d} /></span>)}</span>}
     </summary>
     <div className="ptb-detail">
      <p className="ptb-message-body">{detail(r)}</p>
      {r?.kind === "alert" && <p>Kind: {r.alertKind} · <Status message={r} /> by authority{r.task ? ` · Task: ${r.task}` : ""}</p>}
      {r?.kind === "lead-update" && <p>Event: {r.eventKind}{r.task ? ` · Task: ${r.task}` : ""}{r.tasks?.length ? ` · Tasks: ${r.tasks.join(", ")}` : ""}{r.worker ? ` · Worker: ${r.worker}` : ""}</p>}
      {r?.kind === "delivery" && <DeliveryDetail delivery={r} />}
      {row.deliveries.map(d => <DeliveryDetail key={d.id} delivery={d} />)}
      <p className="ptb-id">Source: {value.source} · Epoch: {value.epoch} · Record: {row.id}</p>
     </div>
    </details>
   </li>;
  })}</ol>
  {filtered.length > PAGE && <nav className="ptb-pagination" aria-label="Message pages"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage * PAGE + 1}–{Math.min((currentPage + 1) * PAGE, filtered.length)} of {filtered.length}</span><button disabled={(currentPage + 1) * PAGE >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
 </section>;
}
