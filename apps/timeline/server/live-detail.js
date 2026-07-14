import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createSourceWatcher } from "./watcher.js";
import { SessionRegistry } from "./session-registry.js";
import { resolveCoreHost, resolveServicePort } from "./service-config.js";

const run = promisify(execFile);
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const scriptJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

export function isDefaultLiveEntry(entry) {
  if (entry?.type !== "message") return false;
  if (entry.message?.role === "user") return true;
  return (
    entry.message?.role === "assistant" &&
    Boolean(entry.message.stopReason) &&
    entry.message.stopReason !== "toolUse"
  );
}

export function defaultLiveEntryIds(path) {
  const ids = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (isDefaultLiveEntry(entry) && typeof entry.id === "string") ids.push(entry.id);
      } catch {
        // A session may be observed between append writes. Keep all preceding complete records.
      }
    }
  } catch {
    return ids;
  }
  return ids;
}

export function createLiveEntryProjection(initialEntryIds = []) {
  let mode = "turns";
  let defaultEntryIds = new Set(initialEntryIds);
  const projectionClass = "hc-default-turns-hidden";
  const observers = new WeakMap();
  const clear = (doc) => {
    for (const node of doc?.querySelectorAll(`.${projectionClass}`) ?? [])
      node.classList.remove(projectionClass);
  };
  const entryId = (node) => (node.id?.startsWith("entry-") ? node.id.slice(6) : null);
  const apply = (doc) => {
    if (!doc || mode !== "turns") return;
    for (const node of doc.querySelectorAll(".tree-node"))
      node.classList.toggle(projectionClass, !defaultEntryIds.has(node.dataset.id));
    for (const node of doc.querySelectorAll("#messages > *"))
      node.classList.toggle(projectionClass, !defaultEntryIds.has(entryId(node)));
    const status = doc.querySelector("#tree-status");
    const all = doc.querySelectorAll(".tree-node").length;
    const visible = doc.querySelectorAll(`.tree-node:not(.${projectionClass})`).length;
    if (status) status.textContent = `${visible} / ${all} entries`;
  };
  const observeRenders = (doc) => {
    if (observers.has(doc) || !doc.defaultView?.MutationObserver) return;
    const observer = new doc.defaultView.MutationObserver(() => apply(doc));
    for (const root of [doc.querySelector("#tree-container"), doc.querySelector("#messages")])
      if (root) observer.observe(root, { childList: true });
    observers.set(doc, observer);
  };
  const prepare = (doc, { controls = false } = {}) => {
    if (!doc) return;
    if (!doc.getElementById("hc-default-turns-style")) {
      const style = doc.createElement("style");
      style.id = "hc-default-turns-style";
      style.textContent = `.${projectionClass}{display:none!important}`;
      doc.head.appendChild(style);
    }
    const allButton = doc.querySelector('.filter-btn[data-filter="all"]');
    if (!doc.documentElement.dataset.hcDefaultTurnsPrepared) {
      allButton?.click();
      doc.documentElement.dataset.hcDefaultTurnsPrepared = "true";
      if (controls) {
        const nativeButtons = [...doc.querySelectorAll(".filter-btn")];
        const first = nativeButtons[0];
        const button = doc.createElement("button");
        button.className = "filter-btn";
        button.dataset.filter = "hc-default-turns";
        button.title = "Only persisted user messages and terminal assistant messages";
        button.textContent = "Turns";
        first?.parentElement?.insertBefore(button, first);
        for (const native of nativeButtons)
          native.addEventListener("click", () => {
            mode = "native";
            clear(doc);
          });
        button.addEventListener("click", () => {
          allButton?.click();
          mode = "turns";
          for (const candidate of doc.querySelectorAll(".filter-btn"))
            candidate.classList.remove("active");
          button.classList.add("active");
          apply(doc);
        });
      }
    }
    if (controls) {
      for (const candidate of doc.querySelectorAll(".filter-btn"))
        candidate.classList.remove("active");
      doc.querySelector('.filter-btn[data-filter="hc-default-turns"]')?.classList.add("active");
      observeRenders(doc);
    }
    apply(doc);
  };
  return {
    prepare,
    setDefaultEntryIds(ids) {
      defaultEntryIds = new Set(ids);
    },
    useTurns() {
      mode = "turns";
    },
  };
}

export function assistantCompletionSignature(path) {
  try {
    let last;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        entry.message.stopReason &&
        entry.message.stopReason !== "toolUse"
      ) {
        last = `${entry.id}:${entry.timestamp}:${entry.message.stopReason}`;
      }
    }
    return last;
  } catch {
    return undefined;
  }
}

export function createLiveDetailServer({
  sessionsRoot,
  cacheRoot = join(homedir(), ".cache", "pi-session-live"),
  exportCommand = "pi",
  exporter = async (source, output) => {
    await run(exportCommand, ["--export", source, output], { timeout: 60_000 });
  },
  watchSources = createSourceWatcher,
} = {}) {
  const registry = new SessionRegistry({ sessionsRoot }).refresh();
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const clients = new Map();
  const versions = new Map();
  const exporting = new Map();
  const completionSignatures = new Map(
    [...registry.byId].map(([id, path]) => [id, assistantCompletionSignature(path)]),
  );
  const rendered = (id) => join(cacheRoot, `${id}.html`);

  async function render(id) {
    const source = registry.get(id);
    if (!source) return false;
    const version = registry.version(id);
    if (versions.get(id) === version && existsSync(rendered(id))) return true;
    if (exporting.has(id)) return exporting.get(id);
    const job = (async () => {
      const previousVersion = versions.get(id);
      const tmp = join(cacheRoot, `.${id}.${process.pid}.tmp.html`);
      await exporter(source, tmp);
      renameSync(tmp, rendered(id));
      versions.set(id, version);
      if (previousVersion !== undefined)
        for (const client of clients.get(id) ?? [])
          client.write(
            `data: ${JSON.stringify({ version, defaultEntryIds: defaultLiveEntryIds(source) })}\n\n`,
          );
      return true;
    })().finally(() => exporting.delete(id));
    exporting.set(id, job);
    return job;
  }

  const watcher = watchSources(
    ({ paths }) => {
      registry.refresh();
      for (const [id, source] of registry.byId)
        if (paths.includes(source)) {
          const next = assistantCompletionSignature(source);
          if (next && next !== completionSignatures.get(id)) {
            completionSignatures.set(id, next);
            render(id).catch(() => {});
          }
        }
    },
    { roots: [sessionsRoot ?? join(homedir(), ".pi", "agent", "sessions")] },
  );

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
    const renderMatch = url.pathname.match(/^\/render\/([^/]+)$/);
    const eventsMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]);
      if (!registry.get(id)) {
        res.writeHead(404);
        return res.end("Unknown session");
      }
      render(id).catch(() => {});
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      const initialDefaultEntryIds = defaultLiveEntryIds(registry.get(id));
      return res.end(`<!doctype html><meta charset="utf-8"><title>Live Pi session ${esc(id)}</title>
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#18181e}#status{position:fixed;right:12px;top:8px;z-index:2;background:#111c;color:#ddd;padding:5px 8px;border-radius:5px;font:12px system-ui}#stage{display:none}</style>
<div id="status" data-update-mode="initial">Live · ${esc(id)}</div>
<iframe id="view" title="Live Pi session ${esc(id)}" src="/render/${encodeURIComponent(id)}"></iframe>
<iframe id="stage" title="Update staging" aria-hidden="true"></iframe>
<script>
const view=document.querySelector('#view'),stage=document.querySelector('#stage'),status=document.querySelector('#status');
let pendingVersion=null;
const liveEntryProjection=(${createLiveEntryProjection.toString()})(${scriptJson(initialDefaultEntryIds)});
view.addEventListener('load',()=>{liveEntryProjection.useTurns();liveEntryProjection.prepare(view.contentDocument,{controls:true})});
function entryIds(doc){return [...(doc?.querySelector('#messages')?.children||[])].map(node=>node.id).filter(Boolean)}
function hardRefresh(version){status.dataset.updateMode='hard';status.textContent='Live · branch changed';view.src='/render/${encodeURIComponent(id)}?v='+encodeURIComponent(version);stage.src='about:blank'}
function attachCopyLink(node){for(const button of node.querySelectorAll('.copy-link-btn'))button.addEventListener('click',event=>{event.stopPropagation();const entry=button.dataset.entryId;const url=new URL(view.contentWindow.location.href);url.searchParams.set('entry',entry);navigator.clipboard?.writeText(url.toString())})}
function reconcile(version){
  pendingVersion=version;stage.onload=()=>{
    if(stage.src==='about:blank')return;
    const oldDoc=view.contentDocument,newDoc=stage.contentDocument;
    liveEntryProjection.prepare(newDoc);
    const oldMessages=oldDoc?.querySelector('#messages'),newMessages=newDoc?.querySelector('#messages');
    const oldIds=entryIds(oldDoc),newIds=entryIds(newDoc);
    const appendOnly=oldMessages&&newMessages&&oldIds.length<=newIds.length&&oldIds.every((id,index)=>id===newIds[index]);
    if(!appendOnly){hardRefresh(version);return}
    const content=oldDoc.querySelector('#content');
    const nearBottom=content ? content.scrollHeight-content.scrollTop-content.clientHeight<80 : false;
    const scrollTop=content?.scrollTop;
    for(let i=oldIds.length;i<newIds.length;i++){const node=oldDoc.importNode(newMessages.children[i],true);attachCopyLink(node);oldMessages.appendChild(node)}
    const oldStats=oldDoc.querySelectorAll('#header-container .info-value'),newStats=newDoc.querySelectorAll('#header-container .info-value');
    oldStats.forEach((node,index)=>{if(newStats[index])node.innerHTML=newStats[index].innerHTML});
    if(content){if(nearBottom)content.scrollTop=content.scrollHeight;else content.scrollTop=scrollTop}
    status.dataset.updateMode='incremental';status.textContent='Live · '+(newIds.length-oldIds.length)+' new entries';
    stage.onload=null;stage.src='about:blank';pendingVersion=null;
  };
  stage.src='/render/${encodeURIComponent(id)}?stage='+encodeURIComponent(version);
}
new EventSource('/api/events/${encodeURIComponent(id)}').onmessage=event=>{const data=JSON.parse(event.data);if(Array.isArray(data.defaultEntryIds))liveEntryProjection.setDefaultEntryIds(data.defaultEntryIds);if(data.version!==pendingVersion)reconcile(data.version)};
</script>`);
    }
    if (req.method === "GET" && renderMatch) {
      const id = decodeURIComponent(renderMatch[1]);
      try {
        await render(id);
      } catch {
        res.writeHead(500);
        return res.end("Export failed");
      }
      if (!existsSync(rendered(id))) {
        res.writeHead(404);
        return res.end("Unknown session");
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return createReadStream(rendered(id)).pipe(res);
    }
    if (req.method === "GET" && eventsMatch) {
      const id = decodeURIComponent(eventsMatch[1]);
      if (!registry.get(id)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("event: ready\ndata: {}\n\n");
      const set = clients.get(id) ?? new Set();
      set.add(res);
      clients.set(id, set);
      req.on("close", () => set.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, sessions: registry.byId.size }));
    }
    res.writeHead(404);
    res.end("Not found");
  });
  server.on("close", () => watcher.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = resolveServicePort("live"),
    host = resolveCoreHost();
  createLiveDetailServer().listen(port, host, () =>
    console.log(`Pi live detail at http://${host}:${port}`),
  );
}
