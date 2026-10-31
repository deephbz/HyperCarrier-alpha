import { useEffect, useRef, useState, type RefObject } from "react";
import { Popover, at } from "./Popover.tsx";

/** The selection end (`right`, `bottom`) is screen px from rects. */
type Anchor = { right: number; bottom: number };
/** `entry` and `fragment` name the selected entry part, so the anchor survives a re-render of that part. */
type Pick = Anchor & { text: string; range: Range; entry: string; fragment: string };

const BODIES = '[data-quote-body], .md, .thinking .body, .tool-body pre, .tool-body .diff';

function selected(root: HTMLElement): Pick | undefined {
 const selection = window.getSelection();
 if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !selection.toString().trim()) return;
 let range = selection.getRangeAt(0);
 const entry = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('[data-entry]');
 let start = entry(range.startContainer), end = entry(range.endContainer);
 // A triple-click ends the range at offset 0 of the next entry. When one edge entry holds all the selected text, the
 // selection is that entry's part of the range.
 if (start && end && start !== end) {
  const all = range.toString().trim();
  const part = (el: Element) => {
   const clipped = document.createRange();clipped.selectNodeContents(el);
   if (range.compareBoundaryPoints(Range.START_TO_START,clipped) > 0) clipped.setStart(range.startContainer,range.startOffset);
   if (range.compareBoundaryPoints(Range.END_TO_END,clipped) < 0) clipped.setEnd(range.endContainer,range.endOffset);
   return clipped;
  };
  const only = [start, end].map(part).find(clipped => clipped.toString().trim() === all);
  if (only) {range = only;start = end = entry(only.startContainer);}
 }
 if (!start || start !== end || !root.contains(start)) return;
 // Intersect the selection with prose and expanded payloads, never entry controls or tool headers.
 const text = [...start.querySelectorAll<HTMLElement>(BODIES)]
  .filter(body => body.getClientRects().length > 0 && !body.closest('details:not([open])') && range.intersectsNode(body))
  .map(body => {
   const clipped = document.createRange();clipped.selectNodeContents(body);
   if (range.compareBoundaryPoints(Range.START_TO_START,clipped) > 0) clipped.setStart(range.startContainer,range.startOffset);
   if (range.compareBoundaryPoints(Range.END_TO_END,clipped) < 0) clipped.setEnd(range.endContainer,range.endOffset);
   // innerText keeps rendered paragraph and code line breaks without bringing chrome along.
   const copy = document.createElement('div');copy.append(clipped.cloneContents());
   copy.style.cssText = 'position:fixed;left:-100000px;white-space:pre-wrap';
   document.body.append(copy);
   // A selected paragraph break adds blank lines at the edges; the map below drops them.
   const text = copy.innerText;copy.remove();return text;
  }).filter(text => text.trim()).map(text => text.replace(/^(?:[ \t]*\n)+|\s+$/g,'')).join('\n\n');
 if (!text.trim()) return;
 const position = placement(root, range);
 return position && {text,range:range.cloneRange(),entry:start.getAttribute('data-entry') ?? '',fragment:start.getAttribute('data-fragment') ?? '',...position};
}

function placement(root: HTMLElement, range: Range): Anchor | undefined {
 if (!root.contains(range.commonAncestorContainer)) return;
 const bounds = root.getBoundingClientRect();
 const rect = [...range.getClientRects()].filter(r => r.bottom > Math.max(bounds.top,0) && r.top < Math.min(bounds.bottom,window.innerHeight) && r.right > bounds.left && r.left < bounds.right).at(-1);
 if (!rect) return;
 return {right:rect.right,bottom:rect.bottom};
}

/**
 * The selection end now. A re-render replaces the selected text nodes, so the stored range then finds the entry part
 * again and the last selected line inside it, or else the end of its prose. Undefined when the entry part left the DOM.
 */
function anchorRange(root: HTMLElement, pick: Pick): Range | undefined {
 const {range} = pick;
 if (!range.collapsed && range.startContainer.isConnected && range.endContainer.isConnected && root.contains(range.commonAncestorContainer)) return range;
 const entry = [...root.querySelectorAll(`[data-entry="${CSS.escape(pick.entry)}"]`)].find(el => (el.getAttribute('data-fragment') ?? '') === pick.fragment);
 if (!entry) return;
 const nodes: Text[] = [];
 for (const body of entry.querySelectorAll<HTMLElement>(BODIES)) {
  if (body.parentElement?.closest(BODIES) || body.getClientRects().length === 0) continue;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
 }
 const all = nodes.map(node => node.data).join('');
 if (!all.trim()) return;
 const line = pick.text.split('\n').map(part => part.trim()).filter(Boolean).at(-1) ?? '';
 const found = line ? all.lastIndexOf(line) : -1;
 const end = found >= 0 ? found + line.length : all.trimEnd().length;
 const start = found >= 0 ? found : Math.max(0, end - 1);
 const at = (offset: number): [Text, number] => {
  for (const node of nodes) {if (offset <= node.data.length) return [node, offset];offset -= node.data.length;}
  const last = nodes.at(-1)!;return [last, last.data.length];
 };
 const next = document.createRange();next.setStart(...at(start));next.setEnd(...at(end));
 return next;
}

/** A box whose anchor is out of view or gone keeps its last place, moved inside the transcript as it is now. */
function held(root: HTMLElement, {right,bottom}: Anchor): Anchor {
 const bounds = root.getBoundingClientRect();
 return {right:Math.max(bounds.left,Math.min(right,bounds.right)),bottom:Math.max(bounds.top,Math.min(bottom,bounds.bottom))};
}

/**
 * A selection stays local until Enter adds it to the Session draft. An open note follows its anchor through scroll,
 * resize, display zoom and transcript reflow, and keeps its draft and focus. The pill is a Popover below the selection's
 * end, inside the transcript.
 */
export function QuoteSelection({onQuote,transcript}: {onQuote:(text:string,note:string)=>void;transcript:RefObject<HTMLDivElement | null>}) {
 const [pick,setPick] = useState<Pick>();
 const [editing,setEditing] = useState(false);
 const [note,setNote] = useState("");
 const input = useRef<HTMLInputElement>(null);
 const pill = useRef<HTMLDivElement>(null);
 const current = useRef(pick);current.current = pick;
 const cancel = () => {setEditing(false);setPick(undefined);setNote("");window.getSelection()?.removeAllRanges();};
 useEffect(() => {
  const root = transcript.current;
  if (!root) return;
  const update = () => {if (!editing) setPick(selected(root));};
  const key = (event: KeyboardEvent) => {
   if (event.key === "Escape" && current.current && event.target instanceof Node && (root.contains(event.target) || pill.current?.contains(event.target))) {event.preventDefault();event.stopPropagation();cancel();return;}
   if (event.key !== "q" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Node) || !root.contains(event.target)) return;
   if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]")) return;
   const next = selected(root);
   if (!next) return;
   event.preventDefault();event.stopPropagation();setPick(next);setEditing(true);
  };
  const follow = () => {
   const last = current.current;
   if (!last) return;
   const range = anchorRange(root,last), position = range && placement(root,range);
   const next = position ? {...last,...position,range} : {...last,...held(root,last)};
   if (next.range !== last.range || next.right !== last.right || next.bottom !== last.bottom) {current.current = next;setPick(next);}
  };
  const reposition = () => {if (editing) follow();else setPick(selected(root));};
  // Transcript reflow (a new message, a streamed delta, a grown row) fires no scroll or resize; coalesce it per frame.
  let frame = 0;
  const reflow = () => {if (editing && !frame) frame = requestAnimationFrame(() => {frame = 0;follow();});};
  const mutations = new MutationObserver(reflow), sizes = new ResizeObserver(reflow);
  if (editing) {mutations.observe(root,{childList:true,characterData:true,subtree:true});sizes.observe(root);}
  document.addEventListener("selectionchange",update);
  document.addEventListener("keydown",key,true);
  root.addEventListener("scroll",reposition);
  for (const name of ["resize","ampi:display"]) window.addEventListener(name,reposition);
  return () => {mutations.disconnect();sizes.disconnect();cancelAnimationFrame(frame);document.removeEventListener("selectionchange",update);document.removeEventListener("keydown",key,true);root.removeEventListener("scroll",reposition);for (const name of ["resize","ampi:display"]) window.removeEventListener(name,reposition);};
 },[transcript,editing]);
 useEffect(() => {if (editing) input.current?.focus({preventScroll:true});},[editing]);
 if (!pick) return null;
 return <Popover ref={pill} className="quote-selection" anchor={() => current.current && at(current.current.right,current.current.bottom)} gap={4} bounds={() => transcript.current?.getBoundingClientRect()}>
  {editing ? <form onSubmit={event => {
   event.preventDefault();
   onQuote(pick.text,note);
   cancel();
  }}><input ref={input} aria-label="Quote note (optional)" placeholder="Reply note (optional) · Enter adds quote to draft" value={note} onChange={event=>setNote(event.target.value)} /></form>
   : <button className="btn small" onMouseDown={event=>event.preventDefault()} onClick={()=>setEditing(true)}>Quote <kbd>q</kbd></button>}
 </Popover>;
}
