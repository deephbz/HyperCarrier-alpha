import { useEffect, useState, type RefObject } from "react";
import type { ThreadOutline } from "../../../src/shared/protocol.ts";
import { hub } from "../client.ts";
import { href } from "../util.ts";

/**
 * The transcript's one strip: a dash per user message at its full-branch ordinal. The transcript scroller stays the
 * only scroll authority; its native bar is hidden where this strip shows. The outline is versioned branch data, and
 * paint-window growth never changes its positions. A new version replaces the outline in place when it arrives, so
 * dashes keep their nodes; until then they are inert. A Host or thread change drops it at once.
 */
export function CompanionScrollbar({host, threadId, version, missingEntry, scroller}: {host:string;threadId:string;version?:string;missingEntry?:string;scroller?:RefObject<HTMLElement | null>}) {
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
 const busy = Boolean(version && outline?.version !== version);
 const title = error || (outline?.truncated ? "User messages · older messages not shown" : "User messages in this thread");
 return <nav className="companion-scrollbar" aria-label="User messages in this thread" title={title} data-outline-version={outline?.version} aria-busy={busy}
  // A wheel over the strip scrolls the transcript, as it did over the native bar.
  onWheel={(event)=>scroller?.current?.scrollBy({top:event.deltaMode===1?event.deltaY*16:event.deltaY})}>
  {outline?.users.map(user=><a key={user.id} data-user-mark={user.id} href={busy ? undefined : href.thread(host,threadId,{entry:user.id})} aria-disabled={busy || undefined}
   title={user.firstLine || "Empty user message"} aria-label={user.firstLine || "Empty user message"}
   style={{top:`${100*user.ordinal/Math.max(1,outline.totalEntries)}%`,height:`min(8px, ${100/Math.max(1,outline.totalEntries)}%)`}}><span /></a>)}
 </nav>;
}
