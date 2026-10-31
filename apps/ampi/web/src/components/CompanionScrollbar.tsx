import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ThreadOutline } from "../../../src/shared/protocol.ts";
import { hub } from "../client.ts";
import { centerInList, href } from "../util.ts";
import { Popover, hoverIntent } from "./Popover.tsx";
import { railLayout, type RailLayout } from "./rail-layout.ts";

export type OutlineState = { outline?: ThreadOutline; busy: boolean; error: string };

/**
 * The thread's prompt outline: versioned branch data. A new version replaces the outline in place when it arrives, so
 * dashes keep their nodes; until then the kept outline is busy (inert). A Host or thread change drops it at once.
 */
export function useThreadOutline(host: string, threadId: string, version?: string, missingEntry?: string): OutlineState {
 const identity = JSON.stringify([host,threadId]);
 const [result,setResult] = useState<{identity:string;outline:ThreadOutline}>();
 const [error,setError] = useState("");
 useEffect(() => {
  let current = true;
  setError("");
  if (!version) return;
  void hub.request(host,"thread.outline",{threadId}).then(outline=>{
   if (!current) return;
   if (outline.version !== version) {setError("Message positions changed; waiting for the current thread version");return;}
   setResult({identity,outline});
  },error=>{if(current)setError(String(error));});
  return ()=>{current=false;};
 },[host,threadId,version,missingEntry]);
 const outline = result?.identity === identity ? result.outline : undefined;
 // Retained dashes belong to an older version: they stay in place but take no hover or click until the current one lands.
 return { outline, busy: Boolean(version && outline?.version !== version), error };
}

/**
 * The reader's place by prompt, read from the rendered user messages: exact IDs, never an estimated ordinal. The
 * current prompt is the last one above the reading line; `scrolledPast` holds once it has left the screen.
 */
export type PromptPlace = { inView: ReadonlySet<string>; current?: { id: string; text: string }; scrolledPast: boolean };
export const NO_PLACE: PromptPlace = { inView: new Set(), scrolledPast: false };

/** The reading line: the transcript's middle, where a reveal (Find, a link, a step) puts its target. */
export const readingLine = (box: DOMRect) => box.top + box.height / 2;

/**
 * The reader's place as one entry: the first transcript entry whose bottom lies past the reading line. A folded group's
 * summary row is not an entry. Undefined when the transcript is hidden (Filter) or ends above the line.
 */
export function readingEntry(scroller: HTMLElement | null): string | undefined {
 const box = scroller?.getBoundingClientRect();
 if (!scroller || !box?.height) return undefined;
 const line = readingLine(box);
 for (const node of scroller.querySelectorAll<HTMLElement>("[data-entry]")) if (!node.closest("summary") && node.getBoundingClientRect().bottom > line) return node.dataset.entry;
 return undefined;
}

export function usePromptPlace(scroller: RefObject<HTMLElement | null>, outline: ThreadOutline | undefined, enabled: boolean): PromptPlace {
 const [place,setPlace] = useState(NO_PLACE);
 const outlineRef = useRef(outline);
 outlineRef.current = outline;
 useEffect(() => {
  const el = scroller.current;
  if (!el || !enabled) return setPlace(NO_PLACE);
  let frame = 0;
  const measure = () => {
   frame = 0;
   const box = el.getBoundingClientRect();
   const line = readingLine(box);
   const inView = new Set<string>();
   let current: HTMLElement | undefined;
   let first: HTMLElement | undefined;
   for (const user of el.querySelectorAll<HTMLElement>(".msg.user[data-entry]")) {
    const r = user.getBoundingClientRect();
    first ??= user;
    if (r.bottom > box.top && r.top < box.bottom) inView.add(user.dataset.entry!);
    if (r.top <= line) current = user;
   }
   const users = outlineRef.current?.users ?? [];
   let id = current?.dataset.entry;
   // Above the first rendered prompt, the reader is in the answer to the outline's prompt before it.
   if (!id && first) id = users[users.findIndex((u) => u.id === first.dataset.entry) - 1]?.id;
   const text = (id && users.find((u) => u.id === id)?.firstLine) || (current?.querySelector("[data-quote-body]")?.textContent ?? current?.textContent ?? "").trim().split("\n")[0]!.slice(0, 120);
   const scrolledPast = Boolean(id) && (!current || current.getBoundingClientRect().bottom < box.top + 4);
   setPlace((p) => p.current?.id === id && p.current?.text === text && p.scrolledPast === scrolledPast && p.inView.size === inView.size && [...inView].every((x) => p.inView.has(x)) ? p : { inView, current: id ? { id, text } : undefined, scrolledPast });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  el.addEventListener("scroll", schedule, { passive: true });
  const observer = new ResizeObserver(schedule);
  // Size changes of the scroller or its content move prompts; a replaced content child is observed again.
  const observe = () => { observer.disconnect(); observer.observe(el); for (const child of el.children) observer.observe(child); schedule(); };
  const children = new MutationObserver(observe);
  children.observe(el, { childList: true });
  observe();
  return () => { el.removeEventListener("scroll", schedule); observer.disconnect(); children.disconnect(); cancelAnimationFrame(frame); };
  // The element itself is a dependency: a remounted scroller needs new listeners.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scroller.current,outline,enabled]);
 return place;
}

const NO_USERS: ThreadOutline["users"] = [];

/** A Find match for the rail, by entry and the prompt it lies under. */
export type RailMark = { id: string; prompt?: string; cur: boolean };
/** The rail a transcript shows: its layout, and the ref that measures its strip. No layout means no rail. */
export type PromptRail = { layout?: RailLayout; strip: (el: HTMLElement | null) => void };

/**
 * The one owner of whether a transcript has a rail: railLayout over the outline's prompts, the prompts on screen, the
 * Find marks and the strip's measured height. ThreadView reads `layout` to choose the rail or the native scrollbar.
 */
export function usePromptRail(outline: ThreadOutline | undefined, place: PromptPlace, marks: readonly RailMark[] | undefined): PromptRail {
 const [height,setHeight] = useState(0);
 const observer = useRef<ResizeObserver>(undefined);
 const strip = useCallback((el: HTMLElement | null) => {
  observer.current?.disconnect();
  observer.current = undefined;
  if (!el) return;
  setHeight(el.clientHeight);
  observer.current = new ResizeObserver(() => setHeight(el.clientHeight));
  observer.current.observe(el);
 }, []);
 useEffect(() => () => observer.current?.disconnect(), []);
 const users = outline?.users ?? NO_USERS;
 const index = useMemo(() => new Map(users.map((u, i) => [u.id, i])), [users]);
 const layout = useMemo(() => {
  const inView = new Set([...place.inView].map((id) => index.get(id) ?? -1));
  // A match before the first prompt, or under one older than the outline holds, sits above the first dash.
  const finds = marks?.map((m) => { const p = m.prompt === undefined ? -1 : index.get(m.prompt) ?? -1; return { id: m.id, at: p < 0 ? -0.5 : p + (m.id === m.prompt ? 0 : 0.5), cur: m.cur }; });
  return railLayout(users.length, inView, height, finds);
 }, [users.length, index, place.inView, height, marks]);
 return { layout, strip };
}

/**
 * The prompt rail: a short stack of dashes, one per prompt it shows, centered at the transcript's right edge in prompt
 * order (railLayout). The prompts on screen are dark and long; the current one is the boldest. It has no track. Every
 * prompt keeps a dash node; the ones the layout leaves out are hidden. Hover or focus opens the prompt outline, a
 * Popover on its left. The transcript scroller stays the only scroll authority; its native bar is hidden where the
 * rail shows. ThreadView renders it only when usePromptRail gives a layout.
 */
export function CompanionScrollbar({host, threadId, state, place, scroller, layout, strip}: {host:string;threadId:string;state:OutlineState;place:PromptPlace;scroller?:RefObject<HTMLElement | null>;layout:RailLayout;strip:PromptRail["strip"]}) {
 const {outline, busy, error} = state;
 const [open,setOpen] = useState(false);
 const users = outline?.users ?? NO_USERS;
 const tier = (id: string) => place.current?.id === id ? "in cur" : place.inView.has(id) ? "in" : undefined;
 const timer = useRef(0);
 const list = useRef<HTMLDivElement>(null);
 const rail = useRef<HTMLDivElement>(null);
 useEffect(() => () => clearTimeout(timer.current), []);
 // The outline opens at the reader's prompt.
 useEffect(() => { const cur = list.current?.querySelector<HTMLElement>(".cur"); if (open && cur) centerInList(list.current!, cur); }, [open]);
 const title = error || (outline?.truncated ? "User messages · older messages not shown" : "User messages in this thread");
 const show = (next: boolean, delay: number) => { clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(next), delay); };
 return <div className="prompt-rail" ref={rail} {...hoverIntent(() => show(true, 250))} onMouseLeave={() => show(false, 150)}
  onFocus={() => show(true, 0)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && show(false, 0)}>
  <nav className="companion-scrollbar" ref={strip} aria-label="User messages in this thread" title={open ? undefined : title} data-outline-version={outline?.version} aria-busy={busy}
   // A wheel over the strip scrolls the transcript, as it did over the native bar.
   onWheel={(event)=>scroller?.current?.scrollBy({top:event.deltaMode===1?event.deltaY*16:event.deltaY})}>
   {users.map((user, i)=><a key={user.id} data-user-mark={user.id} className={tier(user.id) ?? (layout.shown.has(i) ? undefined : "skip")} href={busy ? undefined : href.thread(host,threadId,{entry:user.id})} aria-disabled={busy || undefined}
    title={user.firstLine || "Empty user message"} aria-label={user.firstLine || "Empty user message"}><span /></a>)}
   {layout.marks.map((mark) => <i key={mark.id} className={mark.cur ? "find-mark cur" : "find-mark"} data-find-mark={mark.id} aria-hidden="true" style={{top:`${mark.y}px`}} />)}
  </nav>
  {open && outline && !busy && <Popover className="prompt-outline quiet-scroll" ref={list} role="list" aria-label="Prompts in this Session" anchor={() => rail.current?.getBoundingClientRect()} side="left" owner={rail.current} onClose={() => show(false, 0)}
   onMouseDown={(e) => e.preventDefault()} onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
   {outline.truncated && <div className="hint">Older prompts not shown</div>}
   {outline.users.map((user, i) => <a key={user.id} role="listitem" href={href.thread(host,threadId,{entry:user.id})} tabIndex={-1} data-outline-item={user.id}
    className={`${place.inView.has(user.id) ? "in" : ""}${place.current?.id === user.id ? " cur" : ""}`}>
    <span className="n">{i + 1}</span><span className="tx">{user.firstLine || "Empty user message"}</span>
   </a>)}
  </Popover>}
 </div>;
}

/**
 * The sticky prompt header: once the reader has scrolled past the prompt they are reading the answer to, it names
 * that prompt and steps to the previous or next one (‹ ›, [ ]). The rail beside the transcript shows position.
 */
export function PromptHeader({host, threadId, state, place}: {host:string;threadId:string;state:OutlineState;place:PromptPlace}) {
 const {outline} = state;
 const cur = place.current;
 if (!cur) return null;
 const users = outline?.users ?? [];
 const i = users.findIndex((u) => u.id === cur.id);
 const link = (id: string | undefined) => (id ? href.thread(host,threadId,{entry:id}) : undefined);
 const step = (target: string | undefined, label: string, glyph: string, key: string, dir: string) => <a className="tb" data-prompt-step={dir} href={link(target)} data-nav="replace" aria-disabled={!target || undefined} aria-label={label} title={`${label} (${key})`}>{glyph}</a>;
 // Kept while the prompt is on screen, hidden and inert, so [ and ] still step.
 return <div className={`prompt-head${place.scrolledPast ? "" : " away"}`} role="navigation" aria-label="Current prompt" inert={!place.scrolledPast || undefined}>
  <div className="in">
   <span className="lbl">You</span>
   {i >= 0 && <span className="hint">#{i + 1}{outline ? ` of ${users.length}` : ""}</span>}
   <a className="q" href={link(cur.id)} data-nav="replace" title="Go to this prompt" dir="auto">{cur.text || "Empty user message"}</a>
   {step(i > 0 ? users[i - 1]!.id : undefined, "Previous prompt", "‹", "[", "prev")}
   {step(i >= 0 ? users[i + 1]?.id : undefined, "Next prompt", "›", "]", "next")}
  </div>
 </div>;
}
