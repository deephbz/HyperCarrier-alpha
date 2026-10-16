#!/usr/bin/env node
// Local session mirror hub. Owns the local copy, HTTP API and SSH transport.
// Native Pi JSONL and Herdr retain evidence and runtime authority.
//
//   remote host                               this machine
//   herdr agent list ─┐                     ┌─ disk copy + line index per Session (~/.cache/hc-mirror/<host>)
//   *.jsonl appends ──┴─ remote-agent.cjs ──ssh (1 channel, push)──┤
//                                           └─ http://127.0.0.1:PORT  (render, page, search locally)
//
// Usage:
//   node mirror.mjs --host my-server              # any ssh target
//   node mirror.mjs --host local --delay-ms 150   # local herdr, simulated one-way latency
// Shipped client: / (web IDE). Experimental HTTP clients live under experiments/.
// Options: --port 7777  --tail-bytes 0 (0 = whole Session)  --remote-node node  --cache-dir DIR
//          --teams off (ignore Pi Team Bright)  --ptb-observation /remote/path/observation.js
//
// HTTP API (all local; only /prompt, /interrupt and /screen cross the link):
//   GET  /agents                         link + agents
//   GET  /session?path=&from=&to=        entries [from,to) by line index; default the last 300
//   GET  /search?path=&q=&limit=         case-insensitive substring search over one Session
//   POST /prompt    {session, text}      remote `herdr agent prompt` (slash commands included)
//   POST /interrupt {session}            remote `herdr agent send-keys <pane> esc`, only while working
//   POST /screen    {session, ms}        stream the remote screen for ms (command output, selectors)
//   GET  /events?token=&watch=&open=     SSE: agents, link, append, reset, live
//   POST /watch?token= {panes, sessions} change the live-screen panes and the opened Sessions
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc, []));
const host = args.host || 'local';
const port = Number(args.port || 7777);
const delayMs = Number(args['delay-ms'] || 0);
const tailBytes = Number(args['tail-bytes'] || 0);
const remoteNode = args['remote-node'] || 'node';
// Team view: on by default when the remote has Pi Team Bright; `--teams off` behaves like a host without it.
const teamsCfg = { teams: args.teams !== 'off', ptbObservation: args['ptb-observation'] || undefined };
const cacheDir = args['cache-dir'] || path.join(process.env.HOME, '.cache/hc-mirror', host.replace(/[^\w.-]/g, '_'));
// Resolve the optional local Markdown asset only when a browser requests it.
function markedScript() {
  const piModules = args['pi-modules'] || path.join(process.env.HOME,
    '.pi/agent/install/releases', fs.readFileSync(path.join(process.env.HOME, '.pi/agent/install/current-version'), 'utf8').trim(), 'node_modules');
  return fs.readFileSync(path.join(piModules, 'marked/lib/marked.umd.js'));
}

// ---- Session store: append-only disk copy + line index; parsed only on demand ----
// S.base is the remote byte where the copy starts (> 0 only with --tail-bytes); S.offset is the
// remote byte where it ends; S.lines[i] is the local file position of entry i.
fs.mkdirSync(cacheDir, { recursive: true });
const indexFile = path.join(cacheDir, 'index.json');
const sessions = new Map();
let saveTimer = null;
function saveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(indexFile, JSON.stringify(Object.fromEntries(
    [...sessions].map(([p, s]) => [p, { file: path.basename(s.file), base: s.base, offset: s.offset }])))), 500);
}
function lineStarts(buf, at, out) {
  let i = -1;
  out.push(at);
  while ((i = buf.indexOf(10, i + 1)) >= 0) if (i + 1 < buf.length) out.push(at + i + 1);
}
function newSession(p, meta) {
  const file = path.join(cacheDir, meta?.file || `${Buffer.from(p).toString('base64url').slice(-80)}.jsonl`);
  const s = { path: p, file, base: meta?.base ?? 0, offset: meta?.base ?? 0, size: 0, lines: [], updatedAt: 0, corpus: null };
  if (meta && fs.existsSync(file)) {
    // Keep only whole lines; the remote resumes after the last one.
    let buf = fs.readFileSync(file);
    const end = buf.lastIndexOf(10) + 1;
    if (end !== buf.length) { fs.truncateSync(file, end); buf = buf.subarray(0, end); }
    if (end) lineStarts(buf, 0, s.lines);
    s.size = end; s.offset = s.base + end; s.updatedAt = fs.statSync(file).mtimeMs;
  } else fs.writeFileSync(file, '');
  sessions.set(p, s);
  return s;
}
try { for (const [p, m] of Object.entries(JSON.parse(fs.readFileSync(indexFile, 'utf8')))) newSession(p, m); } catch {}
const session = (p) => sessions.get(p) || newSession(p);

function readEntries(s, from, to) {
  from = Math.max(0, from); to = Math.min(s.lines.length, to);
  if (to <= from) return [];
  const start = s.lines[from], end = to < s.lines.length ? s.lines[to] : s.size;
  const buf = Buffer.alloc(end - start);
  const fd = fs.openSync(s.file, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { type: 'unparsed', line: l }; } });
}

// ---- search corpus: searchable text per entry, built on first open/search, kept for a few Sessions ----
const textOf = (c) => typeof c === 'string' ? c : (c || []).map((p) => p.type === 'text' ? p.text : '').join('');
function entryText(e) {
  if (e.type === 'message') {
    const m = e.message;
    if (m.role === 'user') return textOf(m.content);
    if (m.role === 'assistant') return (m.content || []).map((p) => p.type === 'text' ? p.text : p.type === 'thinking' ? p.thinking : p.type === 'toolCall' ? `${p.name} ${JSON.stringify(p.arguments)}` : '').join('\n');
    if (m.role === 'toolResult') return textOf(m.content);
    if (m.role === 'bashExecution') return `${m.command}\n${m.output}`;
    return '';
  }
  if (e.type === 'custom_message') return textOf(e.content);
  if (e.type === 'compaction' || e.type === 'branch_summary') return e.summary || '';
  return '';
}
const corpusLru = [];
function corpus(s) {
  if (!s.corpus) {
    const t0 = Date.now();
    const text = readEntries(s, 0, s.lines.length).map(entryText);
    s.corpus = { text, lower: text.map((x) => x.toLowerCase()), buildMs: Date.now() - t0 };
  }
  corpusLru.splice(corpusLru.indexOf(s) >>> 0, 1);
  corpusLru.push(s);
  while (corpusLru.length > 6) corpusLru.shift().corpus = null;
  return s.corpus;
}
// ---- prompt index: entry numbers of user messages, for the pinned prompt above the thread ----
const isPrompt = (e) => e.type === 'message' && e.message?.role === 'user';
function promptIndex(s) {
  if (!s.prompts) { s.prompts = []; readEntries(s, 0, s.lines.length).forEach((e, i) => { if (isPrompt(e)) s.prompts.push(i); }); }
  return s.prompts;
}
// The newest prompt before entry `from`: the one the first loaded entries answer.
function promptBefore(s, from) {
  const p = promptIndex(s);
  let lo = 0, hi = p.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (p[m] < from) lo = m + 1; else hi = m; }
  if (!lo) return null;
  const i = p[lo - 1], text = textOf(readEntries(s, i, i + 1)[0]?.message?.content);
  return { i, text: text.slice(0, 600), truncated: text.length > 600 };
}
function search(s, q, limit) {
  const t0 = performance.now();
  const c = corpus(s);
  const needle = q.toLowerCase();
  const hits = [];
  let total = 0, matches = 0;
  for (let i = 0; i < c.lower.length; i++) {
    let at = c.lower[i].indexOf(needle);
    if (at < 0) continue;
    total++;
    if (hits.length < limit) {
      const t = c.text[i];
      const a = Math.max(0, at - 50), b = Math.min(t.length, at + needle.length + 70);
      hits.push({ i, snippet: (a ? '…' : '') + t.slice(a, b).replace(/\s+/g, ' ') + (b < t.length ? '…' : '') });
    }
    while (at >= 0) { matches++; at = c.lower[i].indexOf(needle, at + needle.length); }
  }
  return { q, total, matches, hits, entries: s.lines.length, ms: +(performance.now() - t0).toFixed(1), buildMs: c.buildMs };
}

// ---- link and clients ----
let agents = [];
let labels = {}; // remote tab/workspace id -> label
let teams = new Map(); // pane -> { session, team, member, role } from the remote's Pi Team Bright observation
const link = { state: 'connecting', hello: null, lastBeat: 0, lastLagMs: null, bytes: 0, reconnects: 0 };
const clients = new Map(); // SSE response -> { token, panes:Set, sessions:Set }
const live = new Map(); // pane -> latest screen text
const pendingAcks = new Map(); // id -> { res, sentAt }
let child = null;
let nextId = 1;

const later = (fn) => (delayMs ? setTimeout(fn, delayMs) : fn());
const send = (cmd) => later(() => child?.stdin.writable && child.stdin.write(JSON.stringify(cmd) + '\n'));
function pushWatch() {
  const panes = new Set();
  for (const c of clients.values()) for (const p of c.panes) panes.add(p);
  send({ t: 'watch', panes: [...panes] });
}
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function broadcast(event, data) { const msg = sse(event, data); for (const res of clients.keys()) res.write(msg); }
// A client receives appended entries for the Sessions it opened or whose panes it watches.
function wants(c, p) { return c.sessions.has(p) || agents.some((a) => a.session === p && c.panes.has(a.pane)); }

function handle(msg) {
  if (msg.at) link.lastLagMs = Date.now() - msg.at; // includes clock skew on real remotes
  switch (msg.t) {
    case 'hello': link.hello = msg; link.state = 'live'; break;
    case 'beat': link.lastBeat = Date.now(); break;
    case 'live': live.set(msg.pane, msg.text); broadcast('live', { pane: msg.pane, session: msg.session, text: msg.text }); return;
    case 'ack': {
      const p = pendingAcks.get(msg.id);
      if (!p) return;
      pendingAcks.delete(msg.id);
      p.res.writeHead(msg.ok ? 200 : 502, { 'content-type': 'application/json' });
      p.res.end(JSON.stringify({ ok: msg.ok, error: msg.error, rttMs: Date.now() - p.sentAt }));
      return;
    }
    case 'teams':
      teams = new Map(msg.members.map((m) => [m.pane, m])); // goodAt is remote wall-clock time; rebase it on this clock with the message's own remote timestamp.
      link.teams = { status: msg.status, codes: msg.codes, goodAt: msg.goodAt && Date.now() - (msg.at - msg.goodAt) };
      broadcast('agents', agentView()); break;
    case 'agents': {
      agents = msg.agents; labels = msg.labels || labels; link.source = msg.source;
      // A copy behind the remote size for > 5 s is stalled; a normal append catches up in one poll.
      for (const a of agents) {
        const s = sessions.get(a.session);
        if (!s || a.bytes == null || a.bytes <= s.offset) { if (s) s.behindSince = 0; continue; }
        s.behindSince ||= Date.now();
      }
      broadcast('agents', agentView());
      return;
    }
    case 'reset': {
      const s = session(msg.path);
      fs.writeFileSync(s.file, '');
      Object.assign(s, { base: msg.offset, offset: msg.offset, size: 0, lines: [], corpus: null, prompts: null });
      saveIndex();
      broadcast('reset', { path: msg.path, truncatedHead: s.base > 0 });
      break;
    }
    case 'chunk': {
      const s = session(msg.path);
      if (msg.offset !== s.offset) return; // stale duplicate after reconnect
      const buf = Buffer.from(msg.data);
      const from = s.lines.length;
      fs.appendFileSync(s.file, buf);
      lineStarts(buf, s.size, s.lines);
      s.size += buf.length; s.offset += buf.length; s.updatedAt = Date.now();
      link.bytes += buf.length;
      saveIndex();
      let parsed = null;
      const parse = () => (parsed ??= msg.data.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { type: 'unparsed', line: l }; } }));
      if (s.corpus) for (const e of parse()) { const t = entryText(e); s.corpus.text.push(t); s.corpus.lower.push(t.toLowerCase()); }
      if (s.prompts) parse().forEach((e, k) => { if (isPrompt(e)) s.prompts.push(from + k); });
      const head = { path: msg.path, from, total: s.lines.length, updatedAt: s.updatedAt };
      for (const [res, c] of clients) res.write(sse('append', wants(c, msg.path) ? { ...head, entries: parse() } : head));
      break;
    }
  }
  broadcast('link', linkView());
}

// A Team label applies only while the pane still runs the exact Session the Membership names.
const teamOfAgent = (a) => { const t = teams.get(a.pane); return t && t.session === a.session ? { name: t.team, member: t.member, role: t.role, membership: t.membership } : undefined; };
const agentView = () => agents.map((a) => {
  const s = sessions.get(a.session);
  const stale = s?.behindSince && Date.now() - s.behindSince > 5000;
  return { ...a, tabLabel: labels[a.tab], workspaceLabel: labels[a.workspace],
    mirrored: s?.lines.length ?? 0, updatedAt: s?.updatedAt ?? 0, behindBytes: stale ? a.bytes - s.offset : 0,
    team: teamOfAgent(a) };
});
const linkView = () => ({ host, ...link, sessions: sessions.size, cacheDir });

// ---- transport: one long-lived channel, reconnect with resume offsets ----
function connect() {
  const offsets = Object.fromEntries([...sessions].map(([p, s]) => [p, s.offset]));
  const cfg = Buffer.from(JSON.stringify({ offsets, tailBytes, ...teamsCfg })).toString('base64');
  const code = Buffer.from(fs.readFileSync(path.join(here, 'remote-agent.cjs'))).toString('base64');
  const remoteCmd = `HCM_CFG=${cfg} exec ${remoteNode} -e "eval(Buffer.from('${code}','base64').toString())"`;
  child = host === 'local'
    ? spawn('sh', ['-c', remoteCmd], { stdio: ['pipe', 'pipe', 'inherit'] })
    : spawn('ssh', ['-T', '-C', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        host, `sh -lc ${JSON.stringify(remoteCmd)}`], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  if (clients.size) pushWatch();
  link.state = 'connecting';
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      later(() => handle(msg));
    }
  });
  child.on('exit', (code) => {
    link.state = `down (exit ${code}); retrying`;
    link.reconnects++;
    broadcast('link', linkView());
    setTimeout(connect, 3000);
  });
}

// ---- local HTTP ----
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
// Sends one remote command and answers the HTTP request when the remote acks it.
function remote(res, cmd) {
  const id = nextId++;
  pendingAcks.set(id, { res, sentAt: Date.now() });
  send({ ...cmd, id });
  setTimeout(() => { if (pendingAcks.delete(id)) json(res, 504, { ok: false, error: 'no ack within 20s' }); }, 20000);
}
const paneOf = (p) => agents.find((a) => a.session === p);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  // Loopback binding does not stop browser rebinding or cross-origin writes.
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host)) return json(res, 403, { ok: false, error: 'untrusted Host' });
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    const type = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if ((origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) || type !== 'application/json') {
      return json(res, 403, { ok: false, error: 'POST requires a local Origin and application/json' });
    }
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(here, 'ide.html')));
  }
  if (url.pathname === '/vendor/marked.js') {
    let script;
    try { script = markedScript(); } catch {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Markdown renderer unavailable. Start the hub with --pi-modules /path/to/node_modules containing marked.\n');
    }
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(script);
  }
  if (url.pathname === '/agents') return json(res, 200, { link: linkView(), agents: agentView() });
  if (url.pathname === '/session') {
    const s = sessions.get(q.get('path'));
    if (!s) return json(res, 200, { total: 0, from: 0, to: 0, entries: [], truncatedHead: false });
    const total = s.lines.length;
    const to = Math.min(total, Number(q.get('to') ?? total));
    const from = Math.max(0, Number(q.get('from') ?? to - 300));
    setImmediate(() => corpus(s)); // warm search for the opened Session
    return json(res, 200, { total, from, to, entries: readEntries(s, from, to), truncatedHead: s.base > 0, prompt: from > 0 ? promptBefore(s, from) : null });
  }
  if (url.pathname === '/search') {
    const s = sessions.get(q.get('path'));
    if (!s || !q.get('q')) return json(res, 200, { q: q.get('q'), total: 0, matches: 0, hits: [], ms: 0 });
    return json(res, 200, search(s, q.get('q'), Number(q.get('limit') || 500)));
  }
  if (req.method === 'POST' && ['/prompt', '/interrupt', '/screen'].includes(url.pathname)) {
    const b = await body(req);
    const a = paneOf(b.session);
    if (!a?.pane) return json(res, 400, { ok: false, error: 'no live pane for this Session' });
    if (url.pathname === '/prompt') {
      if (!b.text?.trim()) return json(res, 400, { ok: false, error: 'empty text' });
      return remote(res, { t: 'prompt', pane: a.pane, text: b.text });
    }
    // Esc on an idle Pi can open its tree selector, so interrupt only a working agent.
    if (url.pathname === '/interrupt') {
      if (a.status !== 'working' && !b.force) return json(res, 409, { ok: false, error: `agent is ${a.status}; nothing to interrupt` });
      return remote(res, { t: 'keys', pane: a.pane, keys: ['esc'] });
    }
    return remote(res, { t: 'screen', pane: a.pane, ms: Math.min(Number(b.ms) || 10000, 120000) });
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const split = (k) => new Set((q.get(k) || '').split(',').filter(Boolean));
    clients.set(res, { token: q.get('token'), panes: split('watch'), sessions: split('open') });
    res.write(sse('agents', agentView()));
    res.write(sse('link', linkView()));
    for (const [pane, text] of live) res.write(sse('live', { pane, text }));
    pushWatch();
    req.on('close', () => { clients.delete(res); pushWatch(); });
    return;
  }
  if (url.pathname === '/watch' && req.method === 'POST') {
    const b = await body(req);
    const c = [...clients.values()].find((x) => x.token === q.get('token'));
    if (c) { c.panes = new Set(b.panes || []); c.sessions = new Set(b.sessions || []); pushWatch(); }
    return res.writeHead(204).end();
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => {
  console.log(`local mirror of ${host}${delayMs ? ` (+${delayMs}ms simulated)` : ''}: http://127.0.0.1:${port}  cache ${cacheDir}`);
  connect();
});
