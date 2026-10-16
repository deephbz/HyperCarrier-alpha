#!/usr/bin/env node
// Multi-host Session mirror: one loopback HTTP hub and one engine/channel/cache per Host.
// Native Pi JSONL and Herdr retain evidence and runtime authority. See README for trust/API.
// Usage: node mirror.mjs --host local --host my-server
// No --host selects local plus enabled saved Herdr machines. Explicit flags replace defaults.
// Options: --port 7777 --delay-ms 0 --tail-bytes 0 --remote-node node --cache-dir DIR
//          --teams off --ptb-observation /remote/path/observation.js --pi-modules DIR
// GET /agents: hosts + host-qualified agents; /session and /search: ?host=&path=...
// POST /prompt, /interrupt, /screen: {host,session,...}; commands use /prompt.
// GET /events: host-qualified SSE; POST /watch: qualified pane/Session arrays.
// Single-host mode retains legacy omitted-host coordinates and array events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function parseArgs(argv) {
  const options = { hosts: [] };
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error('flags need values');
    if (argv[i] === '--host') options.hosts.push(argv[i + 1]);
    else options[argv[i].slice(2)] = argv[i + 1];
  }
  return options;
}
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || 7777);
const delayMs = Number(args['delay-ms'] || 0);
const tailBytes = Number(args['tail-bytes'] || 0);
const remoteNode = args['remote-node'] || 'node';
// Team view: on by default when the remote has Pi Team Bright; `--teams off` behaves like a host without it.
const teamsCfg = { teams: args.teams !== 'off', ptbObservation: args['ptb-observation'] || undefined };
const cacheRoot = args['cache-dir'] || path.join(process.env.HOME, '.cache/hc-mirror');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const refKey = (host, value) => JSON.stringify([host, value]);
export function resolveHosts(machines, selectors = []) {
  if (!Array.isArray(machines)) throw new Error('invalid Herdr machine registry');
  const local = { id: 'local', label: 'local', target: null, session: 'default' };
  const saved = machines.map((m) => {
    if (![m.id, m.label, m.target, m.session].every((s) => typeof s === 'string' && s.length) || typeof m.enabled !== 'boolean') throw new Error('invalid saved machine');
    return { id: `machine:${m.id}`, label: m.label, target: m.target, session: m.session, enabled: m.enabled };
  });
  const selected = selectors.length ? selectors.map((s) => {
    if (s === 'local') return local;
    const matches = saved.filter((m) => m.id === s || m.id === `machine:${s}` || m.label === s);
    if (matches.length > 1) throw new Error('ambiguous Host selector');
    if (matches.length) return matches[0];
    if (s.startsWith('machine:')) throw new Error('unknown saved Host ID');
    return { id: `ssh:${digest(s)}`, label: s, target: s, session: 'default' };
  }) : [local, ...saved.filter((m) => m.enabled)];
  const ids = new Set();
  for (const h of selected) {
    if (ids.has(h.id)) throw new Error('duplicate Host selection');
    if (h.target && (/^[-]/.test(h.target) || /\s/.test(h.target))) throw new Error('unsafe SSH target');
    ids.add(h.id);
  }
  return selected;
}
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const clients = new Map();
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
export function writeEvent(res, event, data) {
  if (res.writableLength > 1_048_576) { res.destroy(); return; }
  res.write(sse(event, data));
}
let engines = [], registryWarning = null, registryAt = null;
const single = () => engines.length === 1;
export function selectHost(list, id) {
  if (!id && list.length !== 1) throw Object.assign(new Error('host is required in multi-host mode'), { status: 400 });
  const h = id ? list.find((x) => x.id === id) : list[0];
  if (!h) throw Object.assign(new Error('unknown Host'), { status: 404 });
  return h;
}
export function watchRefs(list, refs, field) {
  if (!Array.isArray(refs)) throw Object.assign(new Error('watch references must be arrays'), { status: 400 });
  return new Set(refs.map((r) => {
    const h = selectHost(list, typeof r === 'string' ? undefined : r?.host);
    const value = typeof r === 'string' ? r : r?.[field];
    if (typeof value !== 'string' || !value) throw Object.assign(new Error('invalid watch reference'), { status: 400 });
    return refKey(h.id, value);
  }));
}
// Resolve the optional local Markdown asset only when a browser requests it.
function markedScript() {
  const piModules = args['pi-modules'] || path.join(process.env.HOME,
    '.pi/agent/install/releases', fs.readFileSync(path.join(process.env.HOME, '.pi/agent/install/current-version'), 'utf8').trim(), 'node_modules');
  return fs.readFileSync(path.join(piModules, 'marked/lib/marked.umd.js'));
}

// Each engine owns one transport and one rebuildable cache. No cross-host lookup.
export function createEngine(descriptor, publish = () => {}) {
const { id: host, target, session: herdrSession } = descriptor;
const cacheDir = path.join(cacheRoot, 'hosts-v1', digest(JSON.stringify([host, target, herdrSession])));
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
  const file = path.join(cacheDir, meta?.file || `${digest(p)}.jsonl`);
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
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
async function scanEntries(s, visit) {
  let i = 0;
  while (i < s.lines.length) {
    let to = i + 1;
    while (to < s.lines.length && to - i < 128 && s.lines[to] - s.lines[i] < 262144) to++;
    readEntries(s, i, to).forEach((e, k) => visit(e, i + k));
    i = to; await yieldTurn();
  }
}
async function corpus(s) {
  if (!s.corpus) {
    s.building ||= (async () => {
      const epoch = s.epoch, t0 = Date.now(), text = [], lower = [];
      await scanEntries(s, (e) => { const t = entryText(e); text.push(t); lower.push(t.toLowerCase()); });
      if (s.epoch === epoch) s.corpus = { text, lower, buildMs: Date.now() - t0 };
    })().finally(() => { s.building = null; });
    await s.building;
    if (!s.corpus) return corpus(s);
  }
  corpusLru.splice(corpusLru.indexOf(s) >>> 0, 1); corpusLru.push(s);
  while (corpusLru.length > 6) corpusLru.shift().corpus = null;
  return s.corpus;
}
// ---- prompt index: entry numbers of user messages, for the pinned prompt above the thread ----
const isPrompt = (e) => e.type === 'message' && e.message?.role === 'user';
async function promptIndex(s) {
  if (!s.prompts) {
    s.promptBuilding ||= (async () => {
      const epoch = s.epoch, prompts = [];
      await scanEntries(s, (e, i) => { if (isPrompt(e)) prompts.push(i); });
      if (s.epoch === epoch) s.prompts = prompts;
    })().finally(() => { s.promptBuilding = null; });
    await s.promptBuilding;
    if (!s.prompts) return promptIndex(s);
  }
  return s.prompts;
}
// The newest prompt before entry `from`: the one the first loaded entries answer.
async function promptBefore(s, from) {
  const p = await promptIndex(s);
  let lo = 0, hi = p.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (p[m] < from) lo = m + 1; else hi = m; }
  if (!lo) return null;
  const i = p[lo - 1], text = textOf(readEntries(s, i, i + 1)[0]?.message?.content);
  return { i, text: text.slice(0, 600), truncated: text.length > 600 };
}
async function search(s, q, limit) {
  const t0 = performance.now();
  const c = await corpus(s);
  const needle = q.toLowerCase();
  const hits = [];
  let total = 0, matches = 0;
  for (let i = 0; i < c.lower.length; i++) {
    if (i && i % 128 === 0) await yieldTurn();
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
const live = new Map(); // pane -> latest screen text
const pendingAcks = new Map(); // id -> { res, sentAt }
let child = null;
let nextId = 1;

const later = (fn) => (delayMs ? setTimeout(fn, delayMs) : fn());
const send = (cmd) => { const channel = child; later(() => { if (channel === child && channel?.stdin.writable && !channel.killed) channel.stdin.write(JSON.stringify(cmd) + '\n'); }); };
function pushWatch() {
  const panes = new Set();
  for (const c of clients.values()) for (const p of c.panes) { const [h, pane] = JSON.parse(p); if (h === host) panes.add(pane); }
  send({ t: 'watch', panes: [...panes] });
}
function broadcast(event, data) { publish(host, event, data); }
function wants(c, p) { return c.sessions.has(refKey(host, p)) || agents.some((a) => a.session === p && c.panes.has(refKey(host, a.pane))); }

function handle(msg) {
  if (msg.at) link.lastLagMs = Date.now() - msg.at; // includes clock skew on real remotes
  switch (msg.t) {
    case 'hello': link.hello = msg; link.state = 'live'; break;
    case 'status':
      link.state = msg.state;
      if (msg.state !== 'live') { agents = agents.map((a) => ({ ...a, pane: null })); broadcast('agents', agentView()); }
      break;
    case 'beat': link.lastBeat = Date.now(); break;
    case 'live': live.set(msg.pane, msg.text); broadcast('live', { pane: msg.pane, session: msg.session, text: msg.text }); return;
    case 'ack': {
      const p = pendingAcks.get(msg.id);
      if (!p) return;
      pendingAcks.delete(msg.id); clearTimeout(p.timer);
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
      Object.assign(s, { epoch: (s.epoch || 0) + 1, base: msg.offset, offset: msg.offset, size: 0, lines: [], corpus: null, prompts: null });
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
      for (const [res, c] of clients) writeEvent(res, 'append', { host, ...(wants(c, msg.path) ? { ...head, entries: parse() } : head) });
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
  return { ...a, host, tabLabel: labels[a.tab], workspaceLabel: labels[a.workspace],
    mirrored: s?.lines.length ?? 0, updatedAt: s?.updatedAt ?? 0, behindBytes: stale ? a.bytes - s.offset : 0,
    team: teamOfAgent(a) };
});
const linkView = () => ({ host, label: descriptor.label, ...link, sessions: sessions.size, cacheDir,
  reconnectHint: target ? `herdr machine reconnect ${descriptor.label}` : undefined });

// ---- transport: one long-lived channel, reconnect with resume offsets ----
function connect() {
  const offsets = Object.fromEntries([...sessions].map(([p, s]) => [p, s.offset]));
  const cfg = Buffer.from(JSON.stringify({ offsets, tailBytes, herdrSession, ...teamsCfg })).toString('base64');
  const code = Buffer.from(fs.readFileSync(path.join(here, 'remote-agent.cjs'))).toString('base64');
  const remoteCmd = `HCM_CFG=${cfg} exec ${remoteNode} -e "eval(Buffer.from('${code}','base64').toString())"`;
  child = !target
    ? spawn('sh', ['-c', remoteCmd], { stdio: ['pipe', 'pipe', 'inherit'] })
    : spawn('ssh', ['-T', '-C', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '--', target, `sh -lc ${JSON.stringify(remoteCmd)}`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const channel = child;
  child.stdin.on('error', () => {});
  if (clients.size) pushWatch();
  link.state = 'connecting';
  let buf = '';
  child.stdout.setEncoding('utf8');
  let draining = false;
  function drain() {
    const i = buf.indexOf('\n');
    if (channel !== child || stopped) return;
    if (i < 0) { draining = false; channel.stdout.resume(); return; }
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const msg = JSON.parse(line); later(() => { if (channel === child && !channel.killed && !stopped) handle(msg); }); } catch {}
    setImmediate(drain);
  }
  child.stdout.on('data', (d) => {
    buf += d;
    if (!draining) { draining = true; child.stdout.pause(); setImmediate(drain); }
  });
  child.on('error', (err) => { link.state = `down (${err.code})`; broadcast('link', linkView()); });
  child.on('close', (code) => {
    link.state = `down (exit ${code}); retrying`;
    link.reconnects++;
    agents = agents.map((a) => ({ ...a, pane: null })); live.clear();
    for (const p of pendingAcks.values()) { clearTimeout(p.timer); json(p.res, 503, { ok: false, error: 'Host disconnected; command outcome unknown' }); }
    pendingAcks.clear();
    broadcast('agents', agentView()); broadcast('link', linkView());
    if (!stopped) reconnectTimer = setTimeout(connect, Math.min(30000, 3000 * 2 ** Math.min(link.reconnects - 1, 3)));
  });
}
let stopped = false, reconnectTimer;
function remote(res, cmd) {
  if (link.state !== 'live') return json(res, 503, { ok: false, error: 'Host is not live' });
  const id = nextId++;
  const timer = setTimeout(() => { if (pendingAcks.delete(id)) json(res, 504, { ok: false, error: 'no ack within 20s' }); }, 20000);
  pendingAcks.set(id, { res, sentAt: Date.now(), timer });
  send({ ...cmd, id });
}
function command(res, route, b) {
  const matches = agents.filter((a) => a.session === b.session && a.pane);
  if (matches.length !== 1) return json(res, 409, { ok: false, error: 'no unambiguous live pane for this Session on this Host' });
  const a = matches[0];
  if (route === '/prompt') {
    if (typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { ok: false, error: 'empty text' });
    return remote(res, { t: 'prompt', pane: a.pane, session: b.session, text: b.text });
  }
  if (route === '/interrupt') {
    if (a.status !== 'working') return json(res, 409, { ok: false, error: 'agent is not working' });
    return remote(res, { t: 'keys', pane: a.pane, session: b.session, keys: ['esc'] });
  }
  return remote(res, { t: 'screen', pane: a.pane, session: b.session, ms: Math.min(Number(b.ms) || 10000, 120000) });
}
return { ...descriptor, sessions, agentView, linkView, connect, command, pushWatch, live,
  page: async (p, q) => {
    const s = sessions.get(p);
    if (!s) return { total: 0, from: 0, to: 0, entries: [], truncatedHead: false };
    const total = s.lines.length, to = Math.min(total, Number(q.get('to') ?? total)), from = Math.max(0, Number(q.get('from') ?? to - 300));
    const prompt = from > 0 ? await promptBefore(s, from) : null;
    setImmediate(() => corpus(s));
    return { total, from, to, entries: readEntries(s, from, to), truncatedHead: s.base > 0, prompt };
  },
  search: async (p, q) => { const s = sessions.get(p); return s && q.get('q') ? search(s, q.get('q'), Number(q.get('limit') || 500)) : { total: 0, matches: 0, hits: [], ms: 0 }; },
  stop: () => { stopped = true; clearTimeout(reconnectTimer); clearTimeout(saveTimer); child?.kill(); },
  handle,
};
}

// ---- local HTTP ----
// Fixed asset allowlist. No path from an HTTP request reaches the filesystem.
const themeAssets = new Map([
  ['/themes.json', ['themes.json', 'application/json']],
  ['/vendor/paper-mono/PaperMono.woff2', ['vendor/paper-mono/PaperMono.woff2', 'font/woff2']],
  ['/vendor/paper-mono/OFL.txt', ['vendor/paper-mono/OFL.txt', 'text/plain; charset=utf-8']],
]);
function themedPage() {
  let data = 'null';
  try { data = JSON.stringify(JSON.parse(fs.readFileSync(path.join(here, 'themes.json'), 'utf8'))).replace(/</g, '\\u003c'); } catch {}
  return fs.readFileSync(path.join(here, 'ide.html'), 'utf8').replace('<script type="application/json" id="theme-data">null</script>',
    `<script type="application/json" id="theme-data">${data}</script>`);
}
const body = (req) => new Promise((ok, fail) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { fail(Object.assign(new Error('invalid JSON'), { status: 400 })); } }); });

export function makeServer() { return http.createServer(async (req, res) => {
 try {
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(themedPage());
  }
  if (themeAssets.has(url.pathname)) {
    const [file, type] = themeAssets.get(url.pathname);
    let bytes;
    try { bytes = fs.readFileSync(path.join(here, file)); } catch { return json(res, 503, { ok: false, error: 'theme asset unavailable' }); }
    const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
    const headers = { 'content-type': type, 'cache-control': 'public, max-age=0, must-revalidate', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    return res.end(bytes);
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
  if (url.pathname === '/agents') return json(res, 200, { ...hostSnapshot(), agents: engines.flatMap((h) => h.agentView()),
    ...(single() ? { link: engines[0].linkView() } : { compatibility: 'Legacy clients require an explicit single --host, such as --host local.' }) });
  if (['/session', '/search'].includes(url.pathname)) {
    const h = selectHost(engines, q.get('host'));
    return json(res, 200, { host: h.id, path: q.get('path'), ...await h[url.pathname === '/session' ? 'page' : 'search'](q.get('path'), q) });
  }
  if (req.method === 'POST' && ['/prompt', '/interrupt', '/screen'].includes(url.pathname)) {
    const b = await body(req), h = selectHost(engines, b.host);
    return h.command(res, url.pathname, b);
  }
  if (url.pathname === '/events') {
    const refs = (k, field) => {
      const raw = q.get(k);
      if (!raw) return new Set();
      return watchRefs(engines, raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').filter(Boolean), field);
    };
    const c = { token: q.get('token'), panes: refs('watch', 'pane'), sessions: refs('open', 'path') };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    clients.set(res, c);
    writeEvent(res, 'hosts', hostSnapshot());
    for (const h of engines) {
      writeEvent(res, 'agents', single() ? h.agentView() : { host: h.id, agents: h.agentView() });
      writeEvent(res, 'link', h.linkView());
      for (const [pane, text] of h.live) writeEvent(res, 'live', { host: h.id, pane, text });
      h.pushWatch();
    }
    req.on('close', () => { clients.delete(res); for (const h of engines) h.pushWatch(); });
    return;
  }
  if (url.pathname === '/watch' && req.method === 'POST') {
    const b = await body(req), panes = watchRefs(engines, b.panes || [], 'pane'), sessions = watchRefs(engines, b.sessions || [], 'path');
    const c = [...clients.values()].find((x) => x.token === q.get('token'));
    if (c) { c.panes = panes; c.sessions = sessions; for (const h of engines) h.pushWatch(); }
    return res.writeHead(204).end();
  }
  res.writeHead(404).end();
 } catch (e) { if (!res.headersSent) json(res, e.status || 400, { ok: false, error: e.message }); else res.destroy(); }
}); }
function hostSnapshot() { return { hosts: engines.map((h) => ({ id: h.id, label: h.label, link: h.linkView() })), registryAt, registryWarning }; }
function publish(host, event, data) {
  const payload = event === 'agents' ? (single() ? data : { host, agents: data }) : { host, ...data };
  for (const res of clients.keys()) writeEvent(res, event, payload);
}
export async function startHub(descriptors) {
  engines = descriptors.map((h) => createEngine(h, publish));
  const server = makeServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  for (const h of engines) h.connect();
  return { server, engines, stop: () => { for (const res of clients.keys()) res.destroy(); for (const h of engines) h.stop(); server.close(); } };
}
async function main() {
  let machines = [];
  try { machines = await new Promise((resolve, reject) => execFile('herdr', ['machine', 'list', '--json'], { timeout: 5000 }, (err, out) => {
    if (err) reject(err); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }
  })); } catch { registryWarning = 'Herdr registry unavailable; use --host for remote targets'; }
  registryAt = new Date().toISOString();
  const descriptors = resolveHosts(machines, args.hosts);
  const hub = await startHub(descriptors);
  console.log(`Session mirror (${descriptors.map((h) => h.label).join(', ')}): http://127.0.0.1:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { hub.stop(); setTimeout(() => process.exit(0), 100).unref(); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
