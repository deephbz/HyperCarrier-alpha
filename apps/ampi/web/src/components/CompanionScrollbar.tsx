import { useEffect, useState } from "react";
import type { ThreadOutline } from "../../../src/shared/protocol.ts";
import { hub } from "../client.ts";
import { href } from "../util.ts";

/** The outline is versioned branch data. Paint-window growth never changes its positions. */
export function CompanionScrollbar({host, threadId, version, missingEntry}: {host:string;threadId:string;version?:string;missingEntry?:string}) {
 const key = JSON.stringify([host,threadId,version]);
 const [result,setResult] = useState<{key:string;outline:ThreadOutline}>();
 const [error,setError] = useState("");
 useEffect(() => {
  let current = true;
  setResult(undefined);setError("");
  if (!version) return;
  void hub.request(host,"thread.outline",{threadId}).then(outline=>{
   if (!current) return;
   if (outline.version !== version) {setError("Message positions changed; waiting for the current thread version");return;}
   setResult({key,outline});
  },error=>{if(current)setError(String(error));});
  return ()=>{current=false;};
 },[host,threadId,version,missingEntry]);
 const outline = result?.key === key ? result.outline : undefined;
 const title = error || (outline?.truncated ? "User messages · older messages not shown" : "User messages in this thread");
 return <nav className="companion-scrollbar" aria-label="User messages in this thread" title={title} data-outline-version={outline?.version}>
  {outline?.users.map(user=><a key={user.id} data-user-mark={user.id} href={href.thread(host,threadId,{entry:user.id})}
   title={user.firstLine || "Empty user message"} aria-label={user.firstLine || "Empty user message"}
   style={{top:`${100*user.ordinal/Math.max(1,outline.totalEntries)}%`,height:`min(8px, ${100/Math.max(1,outline.totalEntries)}%)`}}><span /></a>)}
 </nav>;
}
