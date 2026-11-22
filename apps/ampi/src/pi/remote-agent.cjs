// AmPi Pi remote agent (v2; contract: apps/ampi/docs/pi-backend.md section 2).
// Evolved from the retired Session Mirror's remote agent.
// Sent inline over `ssh -T <alias> node -` (or run locally); nothing is installed. Zero dependencies.
// Config: HCM_CFG = base64 JSON. Stdout: one JSON frame per line. Stdin: one JSON command per line.
//
// Out: hello, reset/chunk (Session bytes), agents {agents, panes, layout}, teams, limits, ack, live, beat, status.
// In:  {t:'submit', id, session, pane?, text, deliverAs: 'steer'|'followUp', images?: [{data, mimeType}]}
//        images go only through a live control; text may then be empty
//      {t:'submit', id, pane, expectSession, text, deliverAs}   a spawned Session with no file yet (pane from the ledger)
//      {t:'abort', id, session, pane?}
//      {t:'commands', id, session}           slash commands, models and thinking levels from the live control
//      {t:'command', id, session, pane?, name, args?, key?, abort?, deliverAs?}
//                                            one typed slash command: through the live control, or with none, typed into
//                                            an empty editor in the bound pane with Enter, where Pi's TUI runs it; never
//                                            a control submit
//      {t:'screen', id, session, pane, ms}   stream a pane's screen for ms
//      {t:'watch', panes:[...]}              live screen of watched panes while active
//      {t:'spawn', id, requestId, sessionId | resume, cwd, beside?, direction?, label?, name?, prompt?}
//                                            new Pi agent in Herdr (contract section 5), once per requestId
//      {t:'close', id, session, pane, lastPane?}   close a Session's pane
//      {t:'relaunch', id, requestId, session, pane, force?, check?, budgetMs?}
//                                            stop Pi in its pane and start it on the same Session file there
//                                            (contract section 5); `check` reports what a relaunch would lose
//   A `submit`, `commands` or `command` frame may carry `holdMs`: how long a send may wait for a relaunched Pi.
//
// Writes route to the Session's hc-control socket when its descriptor is live (same file, same nonce);
// otherwise to Herdr keys after rechecking the exact pane<->Session binding (`herdr agent get`).
//
// cfg (all optional):
//   host            Host ID reported in hello (default os.hostname(); the hub knows the SSH alias)
//   offsets         { path: byteOffset } already copied by the hub
//   tailBytes       0 = ship whole Sessions
//   pollMs, discoverMs, teamsMs, teams, ptbObservation, herdrSession
//   agentDir        Pi agent dir (default $PI_CODING_AGENT_DIR or ~/.pi/agent)
//   autoCompactResolve  hc-auto-compact's settings resolver as a data: module URL, from the hub (agent-modules.ts)
//   controlStamp    the pi-hc-control build the hub expects; each status op names it as `expect`, and a control on
//                   the same protocol updates itself to it (pi-hc-control update.ts)
//   controlStatusMs status query timeout per socket (default 500)
//   controlSubmitMs submit/abort reply timeout (default 130000; the extension waits up to 120 s on compaction)
//   keys.typeArgv   Herdr argv that types literal text without submitting.
//                   Default ['pane','send-text','{pane}','{text}'].
//   keys.followUp   key tokens that queue the typed text as a follow-up. Default ['alt+enter'].
//   keys.interrupt  key tokens that interrupt a turn. Default ['esc'].
//   agentStartMs    `herdr agent start --timeout` (default 30000); the process gets a few seconds more.
//   shellReadyMs    how long a pane this agent just made may stay `agent_pane_busy` while its shell starts (default 15000)
//   relaunchStopMs  how long a relaunch waits for Pi to exit after SIGTERM (default 10000)
//   relaunchControlMs  how long a relaunch waits for the new Pi's control socket (default 10000)
const fs = require('fs');
const crypto = require('crypto');
const cp = require('child_process');
const net = require('net');
const path = require('path');
const os = require('os');

const cfg = JSON.parse(Buffer.from(process.env.HCM_CFG || 'e30=', 'base64').toString());
// Consume transport payload before any child starts. The Arc bundle can exceed
// Linux's 128 KiB limit for one environment or argv string.
delete process.env.HCM_CFG;
// The pi-hc-control protocol this AmPi speaks (host.ts sends endpoint.ts SCHEMA).
const CONTROL_PROTOCOL = cfg.controlProtocol;

// ---- perf trace ----
// With AMPI_TRACE=<runDir> the agent records Chrome Trace Event spans on the Unix-epoch µs clock: frames sent, Herdr
// calls, control requests, Session reads. It writes <runDir>/trace-<pid>-0.json on exit. Args hold no text or
// paths. Off, each site is one boolean check. The hub evals this file, so the tracer is inline.
const traceDir = process.env.AMPI_TRACE || '';
const tracing = traceDir !== '';
const TRACE_MAX = 200_000;
const traceEvents = tracing ? [
  { ph: 'M', name: 'process_name', pid: process.pid, tid: 0, args: { name: `remote-agent:${cfg.host || os.hostname()}` } },
  { ph: 'M', name: 'thread_name', pid: process.pid, tid: 0, args: { name: 'main' } },
] : null;
let traceDropped = 0;
const traceNow = () => Math.round((performance.timeOrigin + performance.now()) * 1000); // whole µs for Perfetto
function traceSpan(name, cat, ts, args) {
  if (traceEvents.length >= TRACE_MAX) { traceDropped++; return; }
  traceEvents.push({ ph: 'X', name, cat, ts, dur: traceNow() - ts, pid: process.pid, tid: 0, ...(args ? { args } : {}) });
}
function traceFlush() {
  if (traceDropped) traceEvents.push({ ph: 'i', s: 'p', name: 'trace-dropped', cat: 'startup', ts: traceNow(), pid: process.pid, tid: 0, args: { events: traceDropped } });
  try { fs.writeFileSync(path.join(traceDir, `trace-${process.pid}-0.json`), JSON.stringify({ traceEvents })); } catch {}
}
if (tracing) {
  process.on('exit', traceFlush);
  // quit() exits after Arc launch work drains; the exit hook writes the trace.
}
const offsets = cfg.offsets || {};
const tailBytes = cfg.tailBytes || 0;
const pollMs = cfg.pollMs ?? 250;
const discoverMs = cfg.discoverMs ?? 2000;
const maxChunk = 1_000_000;
const agentDir = cfg.agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
const controlDir = path.join(agentDir, 'hc-control');
const controlStatusMs = cfg.controlStatusMs ?? 500;
const controlSubmitMs = cfg.controlSubmitMs ?? 130_000;
const agentStartMs = cfg.agentStartMs ?? 30_000;
const shellReadyMs = cfg.shellReadyMs ?? 15_000;
const relaunchStopMs = cfg.relaunchStopMs ?? 10_000;
const relaunchControlMs = cfg.relaunchControlMs ?? 10_000;
const keys = {
  typeArgv: ['pane', 'send-text', '{pane}', '{text}'],
  followUp: ['alt+enter'],
  interrupt: ['esc'],
  ...(cfg.keys || {}),
};

// ---- Output: one frame per line on fd 1 ----
// The hub can read slowly (load, a busy event loop). Frames wait in this queue with one write in flight; the
// kernel never sees one huge writev, which macOS refuses with ENOBUFS. Transient errors retry. Only a closed
// hub (EPIPE and kin) ends the agent. process.stdout stays unused: its first error destroys the stream.
// Responses to hub requests (`ack`) take their own queue and go out at the next frame boundary, so an action's
// answer never waits behind megabytes of Session bytes. Each queue keeps its order. No response depends on a
// queued Session frame: a forget succeeds only when the hub already holds every byte of that file.
const outQ = [], ackQ = [];
let outHead = null; // the frame being written; frames never interleave
let outBytes = 0, outBusy = false, outRetry = 0;
const outHigh = 8 << 20; // pump() waits above this backlog
const outMax = 1 << 30; // the hub stopped reading
const transient = new Set(['EAGAIN', 'EWOULDBLOCK', 'ENOBUFS', 'ENOMEM', 'EINTR']);
let arcRelay, quitting = false;
async function quit(code, reason) {
  if (quitting) return;
  quitting = true;
  try { fs.writeSync(2, `remote-agent exit ${code}: ${reason}\n`); } catch {}
  try { await (await arcRelay)?.close(); } finally { process.exit(code); }
}
for (const [sig, n] of [['SIGTERM', 15], ['SIGHUP', 1], ['SIGINT', 2]]) process.on(sig, () => quit(128 + n, sig));
function out(o) {
  if (quitting) return;
  const ts = tracing ? traceNow() : 0;
  const b = Buffer.from(JSON.stringify(o) + '\n');
  (o.t === 'ack' || o.t === 'arc.ack' || o.t === 'arc.status' || o.t === 'arc.hello' ? ackQ : outQ).push(b); outBytes += b.length;
  if (outBytes > outMax) quit(1, `stdout backlog ${outBytes} bytes; the hub stopped reading`);
  flush();
  // The span covers serialize and enqueue; the write itself is asynchronous.
  if (tracing) traceSpan(`frame ${o.t}`, 'ipc', ts, { bytes: b.length, backlog: outBytes });
}
// One positioned read of a Session file, traced by size only.
function readAt(fd, buf, len, pos) {
  if (!tracing) return fs.readSync(fd, buf, 0, len, pos);
  const ts = traceNow(), n = fs.readSync(fd, buf, 0, len, pos);
  traceSpan('read', 'io', ts, { bytes: n });
  return n;
}
function flush() {
  if (outBusy) return;
  const b = outHead || ackQ.shift() || outQ.shift();
  if (!b) return;
  outHead = b; outBusy = true;
  fs.write(1, b, 0, b.length, null, (err, n) => {
    outBusy = false;
    if (err) {
      if (!transient.has(err.code)) return quit(0, `stdout ${err.code || err.message}`);
      return setTimeout(flush, Math.min(1000, 5 * 2 ** Math.min(outRetry++, 8)));
    }
    outRetry = 0; outBytes -= n;
    outHead = n < b.length ? b.subarray(n) : null;
    flush();
  });
}
const tracked = new Map(); // path -> { offset }
const forgotten = new Map(Object.entries(cfg.forgotten || {})); // path -> source watermark; unchanged old Team records cannot recopy it

// ---- Herdr CLI ----
// A set HERDR_BIN is the only candidate: a slow answer must never fall through to another Herdr server on PATH.
const herdrCandidates = process.env.HERDR_BIN ? [process.env.HERDR_BIN] : ['herdr', path.join(os.homedir(), '.local/bin/herdr')];
function herdrBin() {
  for (const p of herdrCandidates) {
    const ts = tracing ? traceNow() : 0;
    try { cp.execFileSync(p, ['--version'], { stdio: 'ignore', timeout: 3000 }); return p; } catch {} finally { if (tracing) traceSpan('herdr --version', 'startup', ts); }
  }
  return null;
}
let herdr, probing;
// One stderr line per change of the chosen Herdr: the path only, never arguments.
function useHerdr(p) {
  if (p === herdr) return;
  herdr = p;
  process.stderr.write(`remote-agent herdr: ${p || 'none'}\n`);
}
useHerdr(herdrBin());
// A failed probe is not final: one slow answer under load must not leave the agent without Herdr until restart.
function reprobeHerdr() {
  probing ||= herdrCandidates.reduce((prior, p) => prior.then((found) => found || new Promise((resolve) => {
    const ts = tracing ? traceNow() : 0;
    cp.execFile(p, ['--version'], { timeout: 3000 }, (err) => {
      if (tracing) traceSpan('herdr --version', 'ipc', ts, { ok: !err });
      resolve(err ? null : p);
    });
  })), Promise.resolve(null)).then((found) => { if (found && !herdr) useHerdr(found); return !!herdr; }).finally(() => { probing = null; });
  return probing;
}
const herdrSession = cfg.herdrSession || 'default';
const scoped = (argv) => ['--session', herdrSession, ...argv];
let sessionReady = false, checking;
// A scoped CLI call can create a missing server. Every retry starts with this list.
function checkSession() {
  if (!herdr) return reprobeHerdr().then((found) => found && checkSession());
  const ts = tracing ? traceNow() : 0;
  checking ||= new Promise((resolve) => cp.execFile(herdr, ['session', 'list', '--json'], { timeout: 3000 }, (err, stdout) => {
    if (tracing) traceSpan('herdr session list', 'ipc', ts, { ok: !err });
    let running = false;
    try { running = !err && JSON.parse(stdout).sessions.some((s) => s.name === herdrSession && s.running === true); } catch {}
    sessionReady = running;
    out({ t: 'status', state: running ? 'live' : `session ${herdrSession} not running`, at: Date.now() });
    resolve(running);
  })).finally(() => { checking = null; });
  return checking;
}
function runHerdr(argv, options, cb) {
  if (!sessionReady) return cb(new Error('Herdr session unavailable'));
  const ts = tracing ? traceNow() : 0;
  cp.execFile(herdr, scoped(argv), options, (err, stdout, stderr) => {
    // Only the subcommand: later arguments can carry the owner's text.
    if (tracing) traceSpan(`herdr ${argv.slice(0, 2).join(' ')}`, 'ipc', ts, { ok: !err });
    if (err) { sessionReady = false; out({ t: 'status', state: 'Herdr session check required', at: Date.now() }); }
    cb(err, stdout, stderr);
  });
}
// Any failed call (another pass's timeout or refusal) marks the server unchecked; an action rechecks it first, as
// herdrCall does, instead of failing on an earlier call's outcome.
const herdrRun = async (argv, timeout = 15000) => {
  if (!sessionReady) await checkSession();
  return new Promise((resolve) =>
    runHerdr(argv, { timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
};
async function herdrResult(argv, timeout) {
  const { err, stdout } = await herdrRun(argv, timeout);
  if (err) return null;
  try { return JSON.parse(stdout).result; } catch { return null; }
}

// One Herdr request read as its JSON envelope: the value is `result` (or the object itself), a refusal is
// `error {code,message}`, and a nonzero status without a structured refusal is a failure.
// Returns { value } | { error: { code, message }, timedOut? }.
// A failed call marks the server unchecked, so each call rechecks it first (a refusal is not an outage).
async function herdrCall(argv, timeout = 15000) {
  if (!sessionReady && !await checkSession()) return { error: { code: 'herdr_unavailable', message: `Herdr session ${herdrSession} not running` } };
  const { err, stdout, stderr } = await herdrRun(argv, timeout);
  if (err && (err.killed || err.signal) && !String(stdout || '').trim())
    return { error: { code: 'herdr_timeout', message: `herdr ${argv.slice(0, 2).join(' ')} gave no answer in ${timeout} ms` }, timedOut: true };
  let env;
  try { env = JSON.parse(String(stdout || '').trim() ? stdout : stderr); } catch {}
  if (env && typeof env === 'object' && !Array.isArray(env) && env.error) {
    const code = typeof env.error.code === 'string' ? env.error.code : 'herdr_error';
    const message = typeof env.error.message === 'string' ? env.error.message : 'Herdr refused the request';
    return { error: { code, message } };
  }
  if (err) return { error: { code: 'herdr_failed', message: errText(err, stdout, stderr) } };
  const value = env && typeof env === 'object' && !Array.isArray(env) ? (env.result ?? env) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: { code: 'herdr_malformed', message: `herdr ${argv.slice(0, 2).join(' ')} returned no JSON object` } };
  return { value };
}

// ---- Session byte shipping ----
function track(p, live = false) {
  if (tracked.has(p)) return;
  let size = 0;
  try {
    const st = fs.statSync(p); size = st.size;
    const old = forgotten.get(p);
    if (!live && old && old.size === size && old.mtimeMs === st.mtimeMs) return;
    forgotten.delete(p);
  } catch { return; }
  let offset = offsets[p];
  let truncatedHead = false;
  if (offset === undefined || offset > size) {
    offset = tailBytes ? Math.max(0, size - tailBytes) : 0;
    if (offset > 0) {
      // Align the start to a line boundary so every shipped line parses.
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(65536, size - offset));
      readAt(fd, buf, buf.length, offset);
      fs.closeSync(fd);
      const nl = buf.indexOf(10);
      offset = nl < 0 ? size : offset + nl + 1;
      truncatedHead = true;
    }
    out({ t: 'reset', path: p, offset, truncatedHead });
  }
  tracked.set(p, { offset });
}

// Offset just past the last complete line before `size`, never below `from`. A tail block holds it unless the last
// line is longer than the block.
function wholeEnd(p, from, size) {
  const fd = fs.openSync(p, 'r');
  try {
    for (let end = size; end > from;) {
      const len = Math.min(65536, end - from), buf = Buffer.alloc(len);
      readAt(fd, buf, len, end - len);
      const nl = buf.lastIndexOf(10);
      if (nl >= 0) return end - len + nl + 1;
      end -= len;
    }
    return from;
  } finally { fs.closeSync(fd); }
}

function pump() {
  if (outBytes > outHigh) return; // backpressure: the next tick ships the rest
  for (const [p, st] of tracked) {
    let size, whole;
    try { size = fs.statSync(p).size; } catch { continue; }
    if (size < st.offset) { st.offset = 0; out({ t: 'reset', path: p, offset: 0, truncatedHead: false }); }
    // `size` on each chunk is the file's whole-line length at this stat. A copy shorter than it is still loading;
    // an unfinished last line (a live write, a crash-cut tail) never counts.
    if (size > st.offset) try { whole = wholeEnd(p, st.offset, size); } catch { continue; }
    while (size > st.offset && outBytes <= outHigh) {
      // One entry can exceed maxChunk (an image read is several MB): grow the read until it
      // holds a whole line, or the file ends inside an unfinished line.
      let len = Math.min(maxChunk, size - st.offset), buf, last;
      for (;;) {
        buf = Buffer.alloc(len);
        const fd = fs.openSync(p, 'r');
        readAt(fd, buf, len, st.offset);
        fs.closeSync(fd);
        last = buf.lastIndexOf(10);
        if (last >= 0 || len === size - st.offset) break;
        len = Math.min(len * 2, size - st.offset);
      }
      if (last < 0) break; // partial line; wait for the writer to finish it
      out({ t: 'chunk', path: p, offset: st.offset, size: whole, data: buf.subarray(0, last + 1).toString('utf8') });
      st.offset += last + 1;
    }
  }
}

// Pi Session id from the file header (`{"type":"session","id":...}`), read once per file.
const sessionIds = new Map();
function sessionIdOf(p) {
  if (sessionIds.has(p)) return sessionIds.get(p);
  let id;
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4096);
    const n = readAt(fd, buf, buf.length, 0);
    fs.closeSync(fd);
    const nl = buf.subarray(0, n).indexOf(10);
    if (nl < 0) return undefined; // header not complete yet; retry later
    const head = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    if (head?.type === 'session' && typeof head.id === 'string') id = head.id;
  } catch { return undefined; }
  sessionIds.set(p, id);
  return id;
}

// ---- hc-control descriptors and sockets (contract section 1) ----
// One request per connection: write a JSON line, read the first JSON line back.
function controlRequest(socketPath, req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const ts = tracing ? traceNow() : 0;
    let buf = '', done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true; clearTimeout(timer); sock.destroy();
      if (tracing) traceSpan(`control ${req.op}`, 'ipc', ts, { ok: !err });
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`control socket timeout after ${timeoutMs} ms`)), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.id === req.id) return finish(null, msg);
      }
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('control socket closed without a reply')));
  });
}
let controlSeq = 0;

function readDescriptors() {
  let files = [];
  try { files = fs.readdirSync(controlDir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const list = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(controlDir, f), 'utf8'));
      if (!/^hc-control\/\d+$/.test(d?.schema) || typeof d.sessionFile !== 'string' || typeof d.nonce !== 'string') continue;
      d.socket = typeof d.socket === 'string' ? d.socket : path.join(controlDir, `${d.sessionId}.sock`);
      d.sessionFile = path.resolve(d.sessionFile);
      list.push(d);
    } catch {}
  }
  return list;
}
const pidAlive = (pid) => { if (!Number.isInteger(pid)) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Live means: the descriptor's socket answers `status` with the descriptor's nonce and file. A control on another
// protocol is never asked anything: a live process makes it `{ protocol }`, which takes no op (foreign()).
async function probe(d) {
  if (!pidAlive(d.pid)) return null;
  if (d.schema !== CONTROL_PROTOCOL) return { descriptor: d, value: null, protocol: d.schema };
  try {
    const r = await controlRequest(d.socket, { id: `s${++controlSeq}`, op: 'status', ...(cfg.controlStamp ? { expect: cfg.controlStamp } : {}) }, controlStatusMs);
    const v = r?.ok ? r.value : null;
    if (!v || v.nonce !== d.nonce || path.resolve(v.sessionFile || '') !== d.sessionFile) return null;
    // A new control endpoint (a restart or /reload) can serve other commands: forget the old list.
    if (seenCommands.get(d.sessionFile)?.nonce !== d.nonce) seenCommands.delete(d.sessionFile);
    return { descriptor: d, value: v };
  } catch { return null; }
}
async function liveControls() {
  const res = await Promise.all(readDescriptors().map(probe));
  const map = new Map(); // sessionFile -> { descriptor, value }
  for (const r of res) if (r) map.set(r.descriptor.sessionFile, r);
  return map;
}
// A control that reloads (pi-hc-control endpoint.ts close({ reloading })) leaves its descriptor as
// `state: "reloading"` until its new endpoint opens. While its pid lives, a send for that Session never becomes keys.
// Before the deadline it waits for the new endpoint, in FIFO turns, at most RELOAD_HOLD_MAX at a time; the wait ends
// with a live control or a refusal (`refused`, code control_reloading: nothing was sent). After the deadline it is
// refused at once, until a live descriptor replaces this one or the pid dies (a restart): a Pi hung mid-reload, or one
// reloaded without pi-hc-control, must not get keys. The turn lasts until the caller sends and calls
// `release`, so held sends reach Pi in order.
const RELOAD_HOLD_MAX = 8;
const RELOAD_HOLD_MS = 10000;
const reloadHolds = new Map(); // sessionFile -> { count, tail }
async function liveControlFor(session, holdMs) {
  const file = path.resolve(session);
  // A relaunch holds every send for its Session until the new Pi's control answers (holdForRelaunch). A relaunch lock
  // without a hold here belongs to another agent, or to one that died mid-relaunch: refuse, never type keys.
  const relaunch = relaunchHolds.get(file);
  if (relaunch) return holdForRelaunch(file, relaunch, holdMs);
  if (relaunchLocked(file)) return { refused: RELAUNCHING };
  const fenced = stopFence(file);
  if (fenced) return { refused: fenced };
  return findControl(file);
}
async function findControl(file) {
  // Later sends queue behind held ones, even once the new endpoint answers.
  if (reloadHolds.has(file)) return holdForReload(file, null);
  let reloading = null;
  for (const d of readDescriptors()) if (d.sessionFile === file) {
    if (d.state === 'reloading') { if (pidAlive(d.pid)) reloading = d; continue; }
    const r = await probe(d);
    if (r) return r;
  }
  return reloading ? holdForReload(file, reloading) : null;
}
async function holdForReload(file, d) {
  const hold = reloadHolds.get(file) ?? { count: 0, tail: Promise.resolve(), descriptor: d, since: Date.now() };
  if (hold.count >= RELOAD_HOLD_MAX) return { refused: { code: 'control_reloading', message: `pi-hc-control on this Host is reloading and already holds ${RELOAD_HOLD_MAX} sends for this Session. Send again in a few seconds` } };
  hold.count++;
  reloadHolds.set(file, hold);
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const turn = hold.tail;
  hold.tail = turn.then(() => done);
  const finish = () => { if (--hold.count === 0 && reloadHolds.get(file) === hold) reloadHolds.delete(file); release(); };
  await turn;
  const target = hold.descriptor.targetStamp?.id ?? null;
  const until = Math.min(Number(hold.descriptor.deadline) || 0, hold.since + RELOAD_HOLD_MS);
  while (Date.now() < until) {
    for (const n of readDescriptors()) {
      if (n.sessionFile !== file || n.state === 'reloading') continue;
      const r = await probe(n);
      if (r && (!target || r.value.stamp?.id === target)) return { ...r, release: finish };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  finish();
  return { refused: { code: 'control_reloading', message: 'pi-hc-control on this Host began a reload and did not return within 10 s. Restart this Pi Session' } };
}
const controlView = (r) => r?.protocol ? { live: false, protocol: r.protocol } : r ? {
  live: true, idle: !!r.value.idle, compacting: !!r.value.compacting, stamp: r.value.stamp ?? null,
  pending: { steer: r.value.pending?.steer ?? 0, followUp: r.value.pending?.followUp ?? 0 },
  submissions: Array.isArray(r.value.submissions) ? r.value.submissions.map(submissionView) : [],
} : null;
// The endpoint's start: a Session with no file yet has no other age.
const startedOf = (r) => { const at = Date.parse(r.descriptor.startedAt); return at ? { startedAt: at } : {}; };
// The agent relays each submission record whole; the hub reads it (host.ts controlSubmission). A delivered
// submission is in the Session file, so only its text stays here.
function submissionView(s) {
  if (s.state !== 'delivered') return s;
  const { text, truncated, ...v } = s;
  return v;
}

// ---- discovery: agents and layout ----
// Session files under <agentDir>/sessions/** modified within recentMs: Sessions run outside Herdr appear too.
// Stat only; a file's bytes are read when it is new or has grown (track/pump), its header once (sessionIdOf).
const recentMs = cfg.recentMs ?? 4 * 86_400_000;
function recentSessionFiles() {
  const cutoff = Date.now() - recentMs;
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try { if (fs.statSync(p).mtimeMs > cutoff) found.push(p); } catch {}
    }
  };
  walk(path.join(agentDir, 'sessions'), 0);
  return found;
}
function blankAgent(session, extra) {
  return { session, pane: null, workspace: null, tab: null, name: null, title: null, cwd: null, status: 'unknown', focused: false, ...extra };
}

// Herdr's own order: workspaces and tabs in list order; panes in agent-list order within a tab.
// keptLabels: workspace labels from the last listed pass, used only when `workspace list` failed this pass.
function buildLayout(workspaces, tabs, agents, keptLabels) {
  const wsById = new Map();
  const layout = { workspaces: [] };
  const ws = (id, label = keptLabels?.get(id) ?? null) => {
    if (!wsById.has(id)) { const w = { id, label, tabs: [], tabById: new Map() }; wsById.set(id, w); layout.workspaces.push(w); }
    return wsById.get(id);
  };
  const tab = (w, id, label = null) => {
    if (!w.tabById.has(id)) { const t = { id, label, panes: [] }; w.tabById.set(id, t); w.tabs.push(t); }
    return w.tabById.get(id);
  };
  for (const w of workspaces || []) if (w?.workspace_id) ws(w.workspace_id, w.label ?? null);
  for (const t of tabs || []) {
    if (!t?.tab_id) continue;
    const wid = t.workspace_id || (t.tab_id.includes(':') ? t.tab_id.slice(0, t.tab_id.indexOf(':')) : null);
    if (wid) tab(ws(wid), t.tab_id, t.label ?? null);
  }
  for (const a of agents) {
    if (!a.pane || !a.workspace || !a.tab) continue;
    const t = tab(ws(a.workspace), a.tab);
    if (!t.panes.includes(a.pane)) t.panes.push(a.pane);
  }
  for (const w of layout.workspaces) delete w.tabById;
  return layout;
}

let lastAgents = [];
// A failed `workspace list` keeps these labels, so one slow call does not publish null labels.
let workspaceLabels = new Map();
let discovering = false, discoverAgain = false;
// After a spawn or close: list again now (or right after the running pass) so the hub sees the change quickly.
function rediscover() { if (discovering) discoverAgain = true; else discover(); }
async function discover() {
  if (discovering) return;
  discovering = true; discoverAgain = false;
  const ts = tracing ? traceNow() : 0;
  try {
    const live = await checkSession();
    let agents = [], panes, layout = { workspaces: [] }, source = herdr ? 'herdr' : 'mtime';
    if (live) {
      const workspaces = (await herdrResult(['workspace', 'list'], 3000))?.workspaces;
      const tabs = (await herdrResult(['tab', 'list'], 3000))?.tabs;
      const list = (await herdrResult(['agent', 'list'], 5000))?.agents;
      if (Array.isArray(list)) {
        // Every pane Herdr lists, with or without a Session file: a new Pi agent has none until its first message.
        panes = list.filter((a) => a?.pane_id).map((a) => ({ pane: a.pane_id, workspace: a.workspace_id, tab: a.tab_id, name: a.name ?? null, status: a.agent_status ?? null }));
        agents = list.filter((a) => a.agent_session?.kind === 'path').map((a) => ({
          session: a.agent_session.value,
          pane: a.pane_id, workspace: a.workspace_id, tab: a.tab_id,
          name: a.name, title: a.terminal_title_stripped, cwd: a.cwd,
          status: a.agent_status, focused: a.focused, tokens: a.tokens || {},
          source: 'herdr', pi: a.agent === 'pi' && a.agent_session.agent === 'pi',
        }));
      }
      const listed = Array.isArray(workspaces);
      if (listed) workspaceLabels = new Map(workspaces.filter((w) => w?.workspace_id).map((w) => [w.workspace_id, w.label ?? null]));
      layout = buildLayout(workspaces, tabs, agents, listed ? undefined : workspaceLabels);
    }
    // Control: attach live state; a live Session Herdr does not list still counts (pane null).
    const controls = await liveControls();
    const seen = new Set();
    for (const a of agents) {
      const r = controls.get(path.resolve(a.session));
      a.control = controlView(r);
      if (r) { seen.add(r.descriptor.sessionFile); Object.assign(a, startedOf(r)); }
    }
    for (const [file, r] of controls) {
      if (seen.has(file)) continue;
      // Pi writes the file only with the first message; the descriptor alone makes the Session present until then.
      agents.push(blankAgent(file, { status: r.value ? (r.value.idle ? 'idle' : 'working') : 'unknown', source: 'control', control: controlView(r), ...startedOf(r) }));
    }
    // Recent files no pane or control socket shows: copied and listed, with no pane and no live state.
    const listed = new Set(agents.map((a) => path.resolve(a.session)));
    for (const file of recentSessionFiles()) if (!listed.has(path.resolve(file))) agents.push(blankAgent(file, { source: 'recent', control: null }));
    for (const a of agents) {
      track(a.session, !!(a.pane || a.control?.live));
      const id = a.control ? controls.get(path.resolve(a.session))?.value?.sessionId : undefined;
      a.sessionId = id || sessionIdOf(a.session);
      try { a.bytes = fs.statSync(a.session).size; } catch {} // lets the hub detect a stalled copy
    }
    lastAgents = agents;
    out({ t: 'agents', at: Date.now(), source, agents, ...(panes ? { panes } : {}), layout });
  } catch (e) {
    out({ t: 'status', state: `discovery failed: ${String(e?.message || e).slice(0, 200)}`, at: Date.now() });
  } finally {
    if (tracing) traceSpan('discover', 'ipc', ts);
    discovering = false;
    if (discoverAgain) { discoverAgain = false; setImmediate(discover); }
  }
}

// ---- write path ----
let watched = new Set();
const liveLast = new Map();
const forceUntil = new Map(); // pane -> time until which the screen streams regardless of status

const errText = (err, stdout, stderr) => String(stderr || stdout || err?.message || err).trim().slice(0, 500);
function ackOf(msg, via, r) {
  out({ t: 'ack', id: msg.id, via, at: Date.now(), ...r });
}
const fail = (msg, via, code, message) => ackOf(msg, via, { ok: false, error: { code, message } });
// The gate is the wire protocol (cfg.controlProtocol, pi-hc-control endpoint.ts SCHEMA). A control of another build
// on the same protocol serves every op; the hub logs the drift. A control on another protocol gets no op, and no keys
// either: the refusal carries its protocol, and the hub words the one step (build.ts controlProtocolSkew).
function foreign(msg, r) {
  if (!r.protocol) return false;
  ackOf(msg, 'control', { ok: false, error: { code: 'version_skew', message: `pi-hc-control speaks ${r.protocol}`, protocol: r.protocol } });
  return true;
}
// A control that names this protocol but does not know one of its ops is a protocol fault too: the same refusal.
const refusalOf = (rep, r, op) => rep.error?.code === 'unknown_op'
  ? { code: 'version_skew', message: `pi-hc-control lacks the ${op} op`, protocol: r.descriptor.schema, unknownOp: op }
  : rep.error || { code: 'control_error', message: 'control refused' };

// Exact pane<->Session binding on the named Herdr server. Never inferred from a pane ID alone.
async function boundPane(msg) {
  if (!herdr) return { error: ['no_route', 'no live control socket and herdr not found on this host'] };
  const pane = msg.pane || lastAgents.find((a) => a.session === msg.session && a.pane)?.pane;
  if (!pane) return { error: ['no_route', 'no live control socket and no Herdr pane for this Session'] };
  if (!await checkSession()) return { error: ['herdr_unavailable', `Herdr session ${herdrSession} not running`] };
  const { err, stdout } = await herdrRun(['agent', 'get', pane], 5000);
  let a;
  try { a = JSON.parse(stdout).result.agent; } catch {}
  if (err || a?.agent_session?.kind !== 'path' || a.agent_session.value !== msg.session)
    return { error: ['binding_changed', 'pane Session binding changed'] };
  return { pane, agent: a };
}
// A Session that has no file yet (Pi writes it with the first message) cannot be bound by path. Its pane can: the
// ledger says this agent made the pane for `expectSession`, and Herdr must not show another Session there.
async function spawnedBinding(msg) {
  if (!msg.pane || !spawnedPane(msg.expectSession, msg.pane)) return { error: ['no_route', 'no Session file and no pane made for this Session'] };
  if (!herdr) return { error: ['no_route', 'herdr not found on this host'] };
  if (!await checkSession()) return { error: ['herdr_unavailable', `Herdr session ${herdrSession} not running`] };
  const { err, stdout } = await herdrRun(['agent', 'get', msg.pane], 5000);
  let a;
  try { a = JSON.parse(stdout).result.agent; } catch {}
  if (err || !a) return { error: ['binding_changed', 'the pane is gone'] };
  if (a.agent_session?.kind === 'path' && sessionIdOf(a.agent_session.value) !== msg.expectSession) return { error: ['binding_changed', 'pane Session binding changed'] };
  return { pane: msg.pane, agent: a };
}
const fill = (argv, vars) => argv.map((x) => x.replace(/\{(pane|text)\}/g, (_, k) => vars[k]));

async function viaControl(msg, req, r) {
  r ??= await liveControlFor(msg.session, msg.holdMs);
  if (!r) return false;
  if (r.refused) { fail(msg, 'control', r.refused.code, r.refused.message); return true; }
  try { return await sendViaControl(msg, req, r); } finally { r.release?.(); }
}
async function sendViaControl(msg, req, r) {
  if (foreign(msg, r)) return true;
  try {
    const rep = await controlRequest(r.descriptor.socket, { id: `c${++controlSeq}`, ...req }, controlSubmitMs);
    if (rep.ok) ackOf(msg, 'control', {
      ok: true, evidence: rep.evidence, entryId: rep.entryId, submission: rep.submission,
      ...(Array.isArray(rep.submissions) ? { submissions: rep.submissions.map(submissionView) } : {}),
    });
    else ackOf(msg, 'control', { ok: false, error: refusalOf(rep, r, req.op) });
  } catch (e) {
    // The socket was live a moment ago; the input may or may not have landed. Never retry through keys.
    fail(msg, 'control', 'control_unconfirmed', String(e.message || e));
  }
  return true;
}

// A typed slash command reaches Pi only as a command: through a live control that serves commands, or, with no live
// control, as keys in the bound pane, where Pi's TUI runs it. It never goes through the control's submit, which
// would record the command as a user message (packages/pi-hc-control README, Slash commands). This is the one
// place that chooses, at the moment of sending, so no caller acts on an older answer about the control.
async function viaCommandControl(msg, req, typed) {
  const r = msg.session ? await liveControlFor(msg.session, msg.holdMs) : null;
  if (!r && typed) return commandKeys(msg, typed);
  if (!r) return fail(msg, 'control', 'no_control', 'This Session has no live control socket, so AmPi cannot run slash commands; use the Pi pane');
  if (r.refused) return fail(msg, 'control', r.refused.code, r.refused.message);
  try { await commandViaControl(msg, req, r); } finally { r.release?.(); }
}
async function commandViaControl(msg, req, r) {
  if (foreign(msg, r)) return;
  try {
    const rep = await controlRequest(r.descriptor.socket, { id: `c${++controlSeq}`, ...req }, controlSubmitMs);
    if (rep.ok) {
      const { id: _id, ok: _ok, ...result } = rep;
      if (req.op === 'commands' && Array.isArray(result.value?.commands))
        seenCommands.set(r.descriptor.sessionFile, { nonce: r.descriptor.nonce, names: new Set(result.value.commands.filter((c) => c?.supported !== false).map((c) => c?.name)) });
      ackOf(msg, 'control', { ok: true, ...result });
    } else ackOf(msg, 'control', { ok: false, error: refusalOf(rep, r, req.op) });
  } catch (e) {
    // A command may have run; the outcome is unknown, so it is never retried here.
    fail(msg, 'control', 'control_unconfirmed', String(e.message || e));
  }
}
// Pi 1.4.0's 24 built-in slash commands (core/slash-commands.js; not exported), split as pi-hc-control splits them,
// so one table decides with a control and without one. A test keeps both lists equal to pi-hc-control's.
// PI_BUILTINS: pi-hc-control's BUILTINS, which keys may type. PANE_ONLY: names the owner runs in the Pi pane.
const PI_BUILTINS = ['model', 'thinking', 'name', 'compact'];
const PANE_ONLY = ['settings', 'tree', 'scoped-models', 'export', 'import', 'share', 'bug', 'copy', 'session',
  'changelog', 'hotkeys', 'fork', 'clone', 'trust', 'login', 'logout', 'new', 'resume', 'reload', 'quit'];
// sessionFile -> { nonce, names }: the commands its control endpoint `nonce` listed as supported. probe() forgets it
// when the endpoint changes.
const seenCommands = new Map();

/**
 * Types a slash command into the Session's pane, where Pi's TUI runs it: only a name the control would run, and
 * always with Enter, because Alt+Enter while streaming queues the text as a message. Keys carry no receipt.
 */
function commandKeys(msg, typed) {
  if (PANE_ONLY.includes(msg.name)) return fail(msg, 'keys', 'unsupported_command', `/${msg.name} works only in the Pi pane.`);
  if (!PI_BUILTINS.includes(msg.name) && !seenCommands.get(path.resolve(msg.session))?.names.has(msg.name))
    return fail(msg, 'keys', 'unknown_command', `Pi has no /${msg.name} command that AmPi can type without a control socket`);
  return viaKeys(msg, typed, 'steer', { disposition: 'dispatched', evidence: 'sent' }, true);
}

/**
 * True when the screen shows Pi's editor empty. pi-tui's Editor draws its text between two full-width borders; an
 * empty editor leaves one blank line between them. The bottom border is the last border on the screen and is a pure
 * rule. While Pi works, the top border holds its status (`── ⠋ Working… ───`). A scroll label (`↑ 2 more`) means
 * hidden lines. Any other shape counts as not empty. Derived from pi-tui and pi-coding-agent CustomEditor source,
 * not from a recorded Herdr screen: provisional.
 */
function editorEmpty(stdout) {
  let text = stdout;
  try { const j = JSON.parse(stdout); text = j.result?.text ?? j.result?.output ?? stdout; } catch {}
  const lines = String(text).split('\n').map((line) => line.trim());
  const border = (line) => line.length >= 8 && /^─{2}.*─{2}$/.test(line);
  const bottom = lines.findLastIndex(border);
  if (bottom < 2 || !/^─+$/.test(lines[bottom])) return false;
  const top = lines[bottom - 2];
  return lines[bottom - 1] === '' && border(top) && !/\bmore\b/.test(top);
}

function slashCommand(msg) {
  const req = { op: 'command', name: msg.name };
  for (const k of ['args', 'key', 'abort', 'deliverAs']) if (msg[k] !== undefined) req[k] = msg[k];
  return viaCommandControl(msg, req, `/${msg.name}${msg.args ? ` ${msg.args}` : ''}`);
}

const MESSAGE_NEEDS_CONTROL = 'Pi would run this as a command; no live control to send it as text';

async function submit(msg) {
  const images = Array.isArray(msg.images) && msg.images.length ? msg.images : null;
  if (typeof msg.text !== 'string' || (!msg.text && !images)) return fail(msg, null, 'bad_request', 'text required');
  const deliverAs = msg.deliverAs === 'followUp' ? 'followUp' : 'steer';
  // Keys cannot carry an image: never send the text without its images.
  if (images) {
    const r = msg.session ? await liveControlFor(msg.session, msg.holdMs) : null;
    if (!r) return fail(msg, 'control', 'no_control', 'This Session has no live control socket, so AmPi cannot send images; paste them in the Pi pane');
    return void await viaControl(msg, { op: 'submit', text: msg.text, deliverAs, images: images.map(({ data, mimeType }) => ({ data, mimeType })) }, r);
  }
  if (msg.session && await viaControl(msg, { op: 'submit', text: msg.text, deliverAs })) return;
  return viaKeys(msg, msg.text, deliverAs, { evidence: 'sent' });
}

/**
 * The one keys path: types `text` into the Session's bound pane. Enter starts or steers a turn; a follow-up while
 * busy queues it. Pi's editor sends its whole text on Enter, and runs it as a command when it starts with `/`. So the
 * keys go only into an editor the pane shows empty, and slash text goes only as a `command`: keys cannot send it as
 * a message. The owner can type into the pane between the read and the keys; nothing here can close that window.
 */
async function viaKeys(msg, text, deliverAs, ack, command = false) {
  if (!command && text.trim().startsWith('/')) return fail(msg, 'keys', 'needs_control', MESSAGE_NEEDS_CONTROL);
  const b = msg.session ? await boundPane(msg) : await spawnedBinding(msg);
  if (b.error) return fail(msg, 'keys', ...b.error);
  // A blocked agent shows a dialog; typed text would answer it instead of reaching the editor.
  if (b.agent.agent_status === 'blocked') return fail(msg, 'keys', 'agent_blocked', 'agent is waiting on a dialog in its pane');
  const screen = await herdrRun(['agent', 'read', b.pane, '--source', 'visible']);
  if (screen.err) return fail(msg, 'keys', 'keys_failed', errText(screen.err, screen.stdout, screen.stderr));
  if (!editorEmpty(screen.stdout)) return fail(msg, 'keys', 'editor_not_empty', "The Pi pane's input box is not empty, or AmPi cannot read it; clear it in the Pi pane or send from there");
  if (command) forceUntil.set(b.pane, Date.now() + 15000);
  const busy = b.agent.agent_status === 'working';
  let r;
  if (deliverAs === 'followUp' && busy) {
    // Type into the editor (appending to any draft), then queue it as a follow-up.
    r = await herdrRun(fill(keys.typeArgv, { pane: b.pane, text }));
    if (!r.err) r = await herdrRun(['agent', 'send-keys', b.pane, ...keys.followUp]);
  } else {
    // Steer while busy, or start a turn while idle: Herdr types the text and presses Enter.
    r = await herdrRun(['agent', 'prompt', b.pane, text]);
  }
  if (r.err) return fail(msg, 'keys', 'keys_failed', errText(r.err, r.stdout, r.stderr));
  ackOf(msg, 'keys', { ok: true, ...ack });
}

async function abort(msg) {
  // A stop during a relaunch would reach the new Pi after it starts; there is no turn to stop until then.
  const file = typeof msg.session === 'string' && msg.session ? path.resolve(msg.session) : null;
  if (file && (relaunchHolds.has(file) || relaunchLocked(file))) return fail(msg, 'control', RELAUNCHING.code, 'Pi is relaunching in its pane; there is no turn to stop until it is back');
  if (await viaControl(msg, { op: 'abort' })) return;
  const b = await boundPane(msg);
  if (b.error) return fail(msg, 'keys', ...b.error);
  // Esc in an idle Pi editor acts on the draft or opens navigation; nothing to interrupt, so send nothing.
  if (b.agent.agent_status !== 'working' && b.agent.agent_status !== 'blocked') return ackOf(msg, 'keys', { ok: true, evidence: 'idle' });
  const r = await herdrRun(['agent', 'send-keys', b.pane, ...keys.interrupt]);
  if (r.err) return fail(msg, 'keys', 'keys_failed', errText(r.err, r.stdout, r.stderr));
  ackOf(msg, 'keys', { ok: true, evidence: 'sent' });
}

async function screen(msg) {
  const b = await boundPane(msg);
  if (b.error) return fail(msg, 'keys', ...b.error);
  forceUntil.set(b.pane, Date.now() + (msg.ms || 0));
  liveTail();
  ackOf(msg, 'keys', { ok: true });
}

// ---- Herdr control: create and close Pi agents (contract section 5). Herdr owns panes; we only ask. ----
// Herdr names are lowercase identifiers of at most 32 characters.
function herdrName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32);
  return n || `pi-${Math.random().toString(36).slice(2, 8)}`;
}
const paneIdOf = (o) => (o && typeof o === 'object' && typeof o.pane_id === 'string' && o.pane_id) ? o.pane_id : null;
// Refusals Herdr gives before it starts anything; every other failure after the pane exists proves nothing.
const START_REFUSALS = ['herdr_unavailable', 'agent_pane_busy', 'pane_not_found', 'invalid_params', 'unsupported_agent_kind'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

// Spawn ledger: one file per requestId, claimed atomically before the split and updated before each later Herdr
// step, so a repeated or concurrent request never splits twice.
const spawnDir = path.join(controlDir, 'spawns');
const ledgerFile = (requestId) => path.join(spawnDir, `${requestId}.json`);
function readLedger(requestId) {
  // A claim being written reads as empty: that is still `splitting`.
  try { return JSON.parse(fs.readFileSync(ledgerFile(requestId), 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : { state: 'splitting' }; }
}
/** Creates the ledger file only if absent. False: another request holds this requestId. */
function claimLedger(requestId, record) {
  fs.mkdirSync(spawnDir, { recursive: true, mode: 0o700 });
  let fd;
  try { fd = fs.openSync(ledgerFile(requestId), 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { fs.writeSync(fd, JSON.stringify({ ...record, at: Date.now() })); } finally { fs.closeSync(fd); }
  return true;
}
function writeLedger(requestId, record) {
  const file = ledgerFile(requestId), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...record, at: Date.now() }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
// The answer an existing ledger gives; nothing in Herdr runs again.
function ledgerAck(msg, l) {
  const base = { ...(l.pane ? { pane: l.pane } : {}), name: l.name, repeat: true };
  if (l.state === 'refused') return ackOf(msg, 'herdr', { ok: false, ...base, error: l.error || { code: 'refused', message: 'Herdr refused the request' } });
  if (!l.pane) return fail(msg, 'herdr', 'outcome_unknown', 'an earlier attempt with this requestId may have made a pane; check Herdr before trying again');
  ackOf(msg, 'herdr', { ok: true, evidence: l.state === 'started' ? 'started' : 'unknown', ...base, ...(l.submitted ? { submitted: l.submitted } : {}) });
}
// A pane this agent created for `sessionId`, per its ledger (the hub uses the Session id as the requestId).
const spawnedPane = (sessionId, pane) => {
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) return false;
  const l = readLedger(sessionId);
  return !!l && l.sessionId === sessionId && l.pane === pane;
};

async function spawnAgent(msg) {
  if (typeof msg.cwd !== 'string' || !msg.cwd) return fail(msg, 'herdr', 'bad_request', 'cwd required');
  if (typeof msg.requestId !== 'string' || !ID_RE.test(msg.requestId)) return fail(msg, 'herdr', 'bad_request', 'requestId must be a UUID');
  // A new Session gets its id before Pi starts; a resume names the exact Session file (as PTB's exact resume does).
  const resume = msg.resume;
  if (resume !== undefined) {
    if (typeof resume !== 'string' || !path.isAbsolute(resume) || !resume.endsWith('.jsonl') || !fs.existsSync(resume)) return fail(msg, 'herdr', 'bad_request', 'resume must be an existing Session file');
  } else if (typeof msg.sessionId !== 'string' || !ID_RE.test(msg.sessionId)) return fail(msg, 'herdr', 'bad_request', 'sessionId must be a UUID');
  if (msg.beside !== undefined && (typeof msg.beside !== 'string' || !msg.beside)) return fail(msg, 'herdr', 'bad_request', 'beside must be a pane id');
  if (msg.prompt !== undefined && typeof msg.prompt !== 'string') return fail(msg, 'herdr', 'bad_request', 'prompt must be text');
  const direction = msg.direction === undefined ? 'right' : msg.direction;
  if (direction !== 'right' && direction !== 'down') return fail(msg, 'herdr', 'bad_request', 'direction must be right or down');
  const { requestId, sessionId } = msg;
  const prior = readLedger(requestId);
  if (prior) return ledgerAck(msg, prior);
  if (!herdr) return fail(msg, 'herdr', 'no_route', 'herdr not found on this host');
  if (!await checkSession()) return fail(msg, 'herdr', 'herdr_unavailable', `Herdr session ${herdrSession} not running`);
  const name = herdrName(msg.name);
  const record = { requestId, ...(resume ? { resume } : { sessionId }), name, cwd: msg.cwd };
  if (!claimLedger(requestId, { ...record, state: 'splitting' })) return ledgerAck(msg, readLedger(requestId) || { state: 'splitting' });
  // A split that times out or answers without a pane may still have made one: the ledger stays `splitting`.
  let pane, r;
  if (msg.beside) {
    r = await herdrCall(['pane', 'split', '--pane', msg.beside, '--direction', direction, '--cwd', msg.cwd, '--no-focus']);
    pane = r.error ? null : paneIdOf(r.value.pane);
  } else {
    const label = typeof msg.label === 'string' && msg.label ? msg.label : path.basename(msg.cwd);
    r = await herdrCall(['workspace', 'create', '--no-focus', '--cwd', msg.cwd, '--label', label]);
    pane = r.error ? null : paneIdOf(r.value.root_pane);
  }
  if (!pane) {
    const explicit = r.error && !r.timedOut && !['herdr_failed', 'herdr_malformed'].includes(r.error.code);
    if (explicit) { writeLedger(requestId, { ...record, state: 'refused', error: r.error }); return fail(msg, 'herdr', r.error.code, r.error.message); }
    return fail(msg, 'herdr', 'outcome_unknown', `Herdr may have made a pane (${r.error ? r.error.message : 'no pane id in its reply'}); check Herdr before trying again`);
  }
  writeLedger(requestId, { ...record, pane, state: 'pane' });
  rediscover();
  let warning;
  // Naming failure cannot discard a created pane or authorize another split.
  const renamed = await herdrCall(['pane', 'rename', pane, name], 5000);
  if (renamed.error) warning = `pane not named: ${renamed.error.code}: ${renamed.error.message}`.slice(0, 300);
  // The Session id is bound before Herdr runs anything: Pi creates the Session with exactly this id.
  const piArgs = resume ? ['--session', resume] : ['--session-id', sessionId];
  const start = await startInPane(name, pane, piArgs, shellReadyMs);
  rediscover();
  const base = { pane, name, ...(warning ? { warning } : {}) };
  if (start.error && START_REFUSALS.includes(start.error.code)) {
    writeLedger(requestId, { ...record, pane, state: 'refused', error: start.error });
    return ackOf(msg, 'herdr', { ok: false, ...base, error: start.error });
  }
  // A readiness timeout can follow a successful start: say so, and never retry.
  const state = start.error ? 'unknown' : 'started';
  // Pi writes its Session file only once there is a message, so the first prompt goes with the spawn. This pane is
  // ours (just made, and in the ledger), so no binding recheck. Typing into a pane whose start is unproven could
  // land in a shell: then the prompt is not sent.
  let submitted;
  if (msg.prompt && msg.prompt.trim()) {
    // A new pane's editor is empty; slash text would still run as a command (viaKeys).
    if (msg.prompt.trim().startsWith('/')) submitted = { error: { code: 'needs_control', message: MESSAGE_NEEDS_CONTROL } };
    else if (state !== 'started') submitted = { error: { code: 'not_started', message: 'Pi was not confirmed ready in the pane; the prompt was not sent' } };
    else {
      const typed = await herdrRun(['agent', 'prompt', pane, msg.prompt]);
      submitted = typed.err ? { error: { code: 'keys_failed', message: errText(typed.err, typed.stdout, typed.stderr) } } : { via: 'keys', evidence: 'sent' };
    }
  }
  writeLedger(requestId, { ...record, pane, state, ...(submitted ? { submitted } : {}) });
  ackOf(msg, 'herdr', { ok: true, evidence: state, ...base, ...(submitted ? { submitted } : {}), ...(start.error ? { fact: `${start.error.code}: ${start.error.message}`.slice(0, 300) } : {}) });
}

/**
 * `herdr agent start` in `pane`. A shell runs its startup files and prompt hooks in the foreground first (starship init
 * and prompt take ~0.5 s idle, longer under load); a shell whose Pi just exited takes a moment to get its prompt back.
 * Until the prompt is up, Herdr answers agent_pane_busy and runs nothing. For a pane this agent just made, or one whose
 * Pi it just stopped under the Session's relaunch lock, that refusal is transient: ask again for up to `readyMs`.
 */
async function startInPane(name, pane, piArgs, readyMs) {
  let start;
  for (const until = Date.now() + readyMs; ;) {
    start = await herdrCall(['agent', 'start', name, '--kind', 'pi', '--pane', pane, '--timeout', String(agentStartMs), '--', ...piArgs], agentStartMs + 5000);
    if (start.error?.code !== 'agent_pane_busy' || Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (start.error?.code === 'agent_pane_busy')
    start.error = { ...start.error, message: `${start.error.message} after ${Math.round(readyMs / 1000)} s; its shell never reached an idle prompt` };
  return start;
}

async function closePane(msg) {
  if (!(typeof msg.session === 'string' && msg.session) && !msg.expectSession || typeof msg.pane !== 'string' || !msg.pane) return fail(msg, 'herdr', 'bad_request', 'session (or expectSession) and pane required');
  // Any pane closes, as in Herdr itself: a Team tracks its own members' exits.
  if (!herdr) return fail(msg, 'herdr', 'no_route', 'herdr not found on this host');
  if (!await checkSession()) return fail(msg, 'herdr', 'herdr_unavailable', `Herdr session ${herdrSession} not running`);
  // Ordered get -> list -> recheck -> close. A change between the recheck and the close is not excluded.
  const got = await herdrCall(['pane', 'get', msg.pane], 5000);
  if (got.error) return fail(msg, 'herdr', got.error.code, got.error.message);
  const ws = got.value.pane?.workspace_id;
  if (paneIdOf(got.value.pane) !== msg.pane || typeof ws !== 'string' || !ws) return fail(msg, 'herdr', 'herdr_malformed', 'pane get did not return the exact pane and its workspace');
  const listed = await herdrCall(['pane', 'list', '--workspace', ws], 5000);
  if (listed.error) return fail(msg, 'herdr', listed.error.code, listed.error.message);
  if (!Array.isArray(listed.value.panes)) return fail(msg, 'herdr', 'herdr_malformed', 'pane list did not return panes');
  // Closing the last pane deletes the workspace: only after the owner confirmed it.
  if (listed.value.panes.length <= 1 && msg.lastPane !== true)
    return fail(msg, 'herdr', 'final_pane', `pane ${msg.pane} is the last pane in workspace ${ws}; closing it closes the workspace`);
  // A new agent with no Session file yet is bound through the spawn ledger, as for submit.
  const b = msg.session ? await boundPane(msg) : await spawnedBinding(msg);
  if (b.error) return b.error[0] === 'binding_changed' ? fail(msg, 'herdr', 'pane_moved', 'the pane no longer shows this Session') : fail(msg, 'herdr', ...b.error);
  const closed = await herdrCall(['pane', 'close', msg.pane], 5000);
  rediscover();
  if (closed.error) return fail(msg, 'herdr', closed.error.code, closed.error.message);
  ackOf(msg, 'herdr', { ok: true, evidence: 'closed' });
}

// ---- Relaunch (contract section 5): stop Pi in its pane, then start it on the same Session file in that pane ----
// One writer per Session file. A lock file per Session, created with `wx`, holds the run's progress and its writer
// (this agent's pid, process start time and boot nonce). A second request for the Session, under any requestId, is
// refused `relaunching` while that writer lives. After the writer died, one request takes the lock over (a marker
// directory named for the dead writer) and continues from the recorded step; it never signals a recorded pid again
// and never starts Pi twice. A run that got as far as the stop leaves an answer per requestId, which answers repeats.
// A refusal before the stop leaves none: the owner may retry the same request with `force`.
const relaunchDir = path.join(controlDir, 'relaunches');
const agentNonce = crypto.randomUUID();
const relaunchRuns = new Map(); // requestId -> Promise<result>: a retry joins the running relaunch
const relaunchActive = new Set(); // Session files this agent relaunches now
const relaunchHolds = new Map(); // sessionFile -> the hold for sends while Pi restarts
const RELAUNCHING = { code: 'relaunching', message: 'Pi is relaunching in its pane; send again when it is back' };
const lockFile = (file) => path.join(relaunchDir, `${crypto.createHash('sha256').update(file).digest('hex').slice(0, 32)}.lock`);
const answerFile = (requestId) => path.join(relaunchDir, `${requestId}.json`);
const relaunchLocked = (file) => fs.existsSync(lockFile(file));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A file being written reads as `{}`: a held lock with no known writer.
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : {}; }
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...value, at: Date.now() }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
/** One `ps` column of a process (`lstart`, `args`); null when it is gone. */
function psField(pid, field) {
  return new Promise((resolve) => cp.execFile('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null)));
}
let selfStart;
const writerId = async () => ({ pid: process.pid, nonce: agentNonce, start: selfStart ??= await psField(process.pid, 'lstart') });
/** The recorded process still runs: its pid lives and started at the recorded time (a pid can be reused). */
async function sameProcess(pid, start) {
  if (!Number.isInteger(pid) || !pidAlive(pid)) return false;
  return !start || await psField(pid, 'lstart') === start;
}
const liveDescriptorFor = (file) => readDescriptors().some((d) => d.sessionFile === file && Number.isInteger(d.pid) && pidAlive(d.pid));

/** The Session's relaunch lock, or the reason it is not this request's. Resumes a lock whose writer died. */
async function claimRelaunch(msg, file) {
  fs.mkdirSync(relaunchDir, { recursive: true, mode: 0o700 });
  const lock = lockFile(file), me = await writerId();
  for (let tries = 0; tries < 3; tries++) {
    const answer = readJson(answerFile(msg.requestId));
    if (answer?.result) return { answer };
    const record = { requestId: msg.requestId, session: file, pane: msg.pane, writer: me, state: 'checking' };
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ ...record, at: Date.now() })); } finally { fs.closeSync(fd); }
      return { record };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const held = readJson(lock);
    if (!held) continue; // released meanwhile
    const w = held.writer;
    if (!w?.nonce) return { refused: RELAUNCHING };
    if (w.nonce !== agentNonce) {
      if (await sameProcess(w.pid, w.start)) return { refused: RELAUNCHING };
      // The writer died. One request per dead writer takes over: the marker's mkdir is atomic.
      try { fs.mkdirSync(`${lock}.taken.${w.nonce}`, { mode: 0o700 }); } catch { return { refused: RELAUNCHING }; }
      const again = readJson(lock);
      if (!again) continue;
      if (again.writer?.nonce !== w.nonce) return { refused: RELAUNCHING };
    }
    // This agent's own lock with no run here (relaunchActive excludes one) is a stopped run: resume it.
    const taken = { ...held, writer: me, ...(held.requestId !== msg.requestId ? { also: msg.requestId } : {}) };
    writeJson(lock, taken);
    return { record: taken };
  }
  return { refused: RELAUNCHING };
}
// A Pi that got SIGTERM from a relaunch and did not exit in time (stop_timeout) is shutting down: its queue may be
// lost, so no send reaches it while its process lives. In memory: an agent restart drops the fence.
const stopFences = new Map(); // sessionFile -> { pid }
function stopFence(file) {
  const fence = stopFences.get(file);
  if (!fence) return null;
  if (pidAlive(fence.pid)) return { code: RELAUNCHING.code, message: 'Pi got the stop signal for a relaunch and has not exited; nothing was sent. Send again after Pi is back' };
  stopFences.delete(file);
  return null;
}
// A held send waits at most what its sender waits for the answer, less a margin (the frame's `holdMs`), so a send the
// Host reported as failed never reaches Pi later. A sender that names no wait gets HOLD_DEFAULT_MS, below the Host's
// shortest send timeout (20 s).
const HOLD_DEFAULT_MS = 15_000;

/** Ends the run: the answer for each requestId it served (when `answer`), then the lock and its takeover markers. */
function releaseRelaunch(file, rec, result, answer) {
  if (answer) for (const id of new Set([rec.requestId, rec.also].filter(Boolean))) writeJson(answerFile(id), { state: rec.state, result });
  const lock = lockFile(file), base = path.basename(lock);
  fs.rmSync(lock, { force: true });
  try { for (const f of fs.readdirSync(relaunchDir)) if (f.startsWith(`${base}.taken.`)) fs.rmSync(path.join(relaunchDir, f), { recursive: true, force: true }); } catch {}
}

// While Pi restarts, every send for its Session waits here, in FIFO turns, at most RELOAD_HOLD_MAX at a time, for a
// live control other than the old one (another nonce and pid). Keys never: the pane shows a shell then. The hold
// ends with the run. After a refusal before the stop (`kept`), the old control serves the waiting sends again.
// From the claim until the stop is recorded, the hold is `pending`: it knows no old control yet, so it only waits.
// Waiting sends keep a reference to the hold, so a later step updates the same object.
function holdSends(file, hold) {
  let h = relaunchHolds.get(file);
  if (!h || h.ended) relaunchHolds.set(file, h = { count: 0, tail: Promise.resolve() });
  Object.assign(h, { pending: false, ...hold, ended: null });
}
function endHold(file, outcome) {
  const hold = relaunchHolds.get(file);
  if (!hold || hold.ended) return;
  hold.ended = outcome;
  if (hold.count === 0) relaunchHolds.delete(file);
}
async function holdForRelaunch(file, hold, holdMs) {
  const until = Math.min(hold.until, Date.now() + Math.max(0, Number.isFinite(holdMs) ? holdMs : HOLD_DEFAULT_MS));
  if (hold.count >= RELOAD_HOLD_MAX) return { refused: { code: RELAUNCHING.code, message: `Pi is relaunching and AmPi already holds ${RELOAD_HOLD_MAX} sends for this Session. Send again when it is back` } };
  hold.count++;
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const turn = hold.tail;
  hold.tail = turn.then(() => done);
  const finish = () => { if (--hold.count === 0 && hold.ended && relaunchHolds.get(file) === hold) relaunchHolds.delete(file); release(); };
  await turn;
  while (!hold.ended && Date.now() < until) {
    if (!hold.pending) for (const n of readDescriptors()) {
      if (n.sessionFile !== file || n.state === 'reloading' || n.nonce === hold.oldNonce || n.pid === hold.oldPid) continue;
      const r = await probe(n);
      if (r) return { ...r, release: finish };
    }
    await sleep(100);
  }
  if (hold.ended) {
    const fenced = stopFence(file);
    if (fenced) { finish(); return { refused: fenced }; }
    const r = await findControl(file);
    if (r && !r.refused) return { ...r, release: () => { r.release?.(); finish(); } };
    if (r?.refused || hold.ended !== 'kept') {
      finish();
      const message = hold.ended === 'started' || hold.ended === 'unknown' ? 'Pi started again without a control socket; send again to type into its pane'
        : 'Pi stopped for a relaunch and did not start again; Resume starts it, then send again';
      return { refused: r?.refused ?? { code: RELAUNCHING.code, message } };
    }
    finish();
    return null;
  }
  finish();
  return { refused: { code: RELAUNCHING.code, message: 'Pi is still relaunching; nothing was sent. Send again after Pi is back' } };
}

/** Launch flags a relaunch does not repeat: everything after `pi` but the Session selection. */
function droppedFlags(args) {
  const tokens = String(args || '').split(/\s+/).filter(Boolean);
  const at = tokens.findIndex((t) => path.basename(t) === 'pi');
  const out = [];
  for (let i = at + 1; at >= 0 && i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--session' || t === '--session-id') { i++; continue; }
    if (t === '--continue' || t === '-c' || t === '--resume' || t === '-r') continue;
    out.push(t.slice(0, 80));
  }
  return out.slice(0, 12);
}

/**
 * What the pane runs now: the bound Pi process, its control, and what a stop would lose. Sends nothing.
 * Pi is the pane's foreground process (argv0 `pi`, the foreground process group); its shell must outlive it, or the
 * pane would close with Pi. A live control for the file must belong to that process: any other is a second writer.
 */
async function inspectPane(msg, file) {
  const b = await boundPane(msg);
  if (b.error) return { error: b.error[0] === 'binding_changed' ? ['binding_changed', 'the pane no longer shows this Session'] : b.error };
  const info = await herdrCall(['pane', 'process-info', '--pane', msg.pane], 5000);
  if (info.error) return { error: info.error.code === 'herdr_failed' && /unrecognized|unexpected|subcommand|invalid/i.test(info.error.message) ? ['herdr_outdated', 'this Herdr has no `pane process-info`; update Herdr on this Host'] : [info.error.code, info.error.message] };
  const p = info.value.process_info ?? info.value;
  const fg = Array.isArray(p.foreground_processes) ? p.foreground_processes : [];
  const isPi = (x) => Number.isInteger(x?.pid) && typeof x.argv0 === 'string' && path.basename(x.argv0) === 'pi';
  const pi = fg.find((x) => isPi(x) && x.pid === p.foreground_process_group_id) ?? fg.find(isPi);
  if (!pi) return { error: ['not_pi', 'AmPi cannot find the Pi process in this pane'] };
  if (!Number.isInteger(p.shell_pid) || p.shell_pid === pi.pid) return { error: ['no_shell', 'Pi is the only process in this pane, so it cannot start again there'] };
  const start = await psField(pi.pid, 'lstart');
  if (!start) return { error: ['not_pi', 'the Pi process in this pane exited'] };
  let control = null;
  for (const d of readDescriptors()) {
    if (d.sessionFile !== file || !Number.isInteger(d.pid) || !pidAlive(d.pid)) continue;
    if (d.pid !== pi.pid) return { error: ['pid_mismatch', `another process (pid ${d.pid}) holds this Session's control socket`] };
    if (d.state === 'reloading') return { error: ['control_reloading', 'pi-hc-control in this Pi is reloading; try again in a few seconds'] };
    const r = await probe(d);
    if (r?.value) control = r;
  }
  const v = control?.value;
  const status = b.agent.agent_status;
  const activity = v ? (v.compacting ? 'compacting' : v.idle ? 'idle' : 'working') : status === 'working' || status === 'blocked' ? status : 'idle';
  const queued = v ? (v.pending?.steer ?? 0) + (v.pending?.followUp ?? 0) : 0;
  const screen = await herdrRun(['agent', 'read', msg.pane, '--source', 'visible'], 5000);
  return {
    agent: b.agent, pid: pi.pid, start, control, activity, queued,
    editorEmpty: !screen.err && editorEmpty(screen.stdout), dropped: droppedFlags(await psField(pi.pid, 'args')),
  };
}

/**
 * Which queued submissions reached the Session file before Pi stopped: a user message with the same text after `size`.
 * Each message settles one submission, so two queued copies of one text need two messages.
 */
function settleQueued(file, rec) {
  const texts = new Map(); // text -> messages left to match
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.max(0, fs.fstatSync(fd).size - (rec.size || 0)), buf = Buffer.alloc(len);
      readAt(fd, buf, len, rec.size || 0);
      for (const line of buf.toString('utf8').split('\n')) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const m = e?.type === 'message' && e.message?.role === 'user' ? e.message : null;
        if (!m) continue;
        const parts = typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.filter((c) => c?.type === 'text').map((c) => c.text) : [];
        for (const text of new Set([parts.join(''), ...parts])) texts.set(text, (texts.get(text) ?? 0) + 1);
      }
    } finally { fs.closeSync(fd); }
  } catch {}
  const returned = [], delivered = [];
  // An expanded submission (a skill or template) reaches the file as other text: its outcome stays unknown.
  for (const q of rec.queued || []) {
    if (q.expanded) continue;
    const left = texts.get(q.text) ?? 0;
    if (left > 0) { texts.set(q.text, left - 1); delivered.push(q.submission); } else returned.push(q.submission);
  }
  return { returned, delivered };
}

async function waitFor(pred, ms) {
  for (const until = Date.now() + ms; ;) {
    if (await pred()) return true;
    if (Date.now() >= until) return false;
    await sleep(100);
  }
}
/** The new Pi's control: live on the file, with another nonce than the stopped one. */
async function newControl(file, oldNonce, ms) {
  let found = null;
  await waitFor(async () => {
    for (const d of readDescriptors()) if (d.sessionFile === file && d.state !== 'reloading' && d.nonce !== oldNonce && (found = await probe(d))?.value) return true;
    found = null;
    return false;
  }, ms);
  return found;
}

async function relaunch(msg) {
  if (typeof msg.requestId !== 'string' || !ID_RE.test(msg.requestId)) return fail(msg, 'herdr', 'bad_request', 'requestId must be a UUID');
  if (typeof msg.session !== 'string' || !path.isAbsolute(msg.session) || typeof msg.pane !== 'string' || !msg.pane) return fail(msg, 'herdr', 'bad_request', 'session and pane required');
  if (!herdr) return fail(msg, 'herdr', 'no_route', 'herdr not found on this host');
  if (!await checkSession()) return fail(msg, 'herdr', 'herdr_unavailable', `Herdr session ${herdrSession} not running`);
  const file = path.resolve(msg.session);
  if (msg.check) {
    if (relaunchActive.has(file) || relaunchLocked(file)) return fail(msg, 'herdr', RELAUNCHING.code, 'Pi is already relaunching in this pane');
    if (stopFence(file)) return fail(msg, 'herdr', 'stop_pending', 'Pi got the stop signal and has not exited yet');
    const i = await inspectPane(msg, file);
    if (i.error) return fail(msg, 'herdr', ...i.error);
    return ackOf(msg, 'herdr', { ok: true, evidence: 'checked', check: { activity: i.activity, queued: i.queued, editorEmpty: i.editorEmpty, dropped: i.dropped, control: !!i.control } });
  }
  let run = relaunchRuns.get(msg.requestId);
  if (!run) {
    run = runRelaunch(msg, file).catch((e) => ({ ok: false, error: { code: 'internal', message: String(e?.message || e).slice(0, 300) } }));
    relaunchRuns.set(msg.requestId, run);
    void run.finally(() => relaunchRuns.delete(msg.requestId));
  }
  ackOf(msg, 'herdr', await run);
}

async function runRelaunch(msg, file) {
  if (relaunchActive.has(file)) return { ok: false, error: RELAUNCHING };
  relaunchActive.add(file);
  try { return await relaunchSteps(msg, file); } finally { relaunchActive.delete(file); endHold(file, 'kept'); }
}

async function relaunchSteps(msg, file) {
  // The Host's timeout for this command is `budgetMs` plus a margin: every wait below fits in what is left.
  const until = Date.now() + Math.max(30_000, Number(msg.budgetMs) || 120_000);
  const left = () => until - Date.now();
  const c = await claimRelaunch(msg, file);
  if (c.answer) return { ...c.answer.result, repeat: true };
  if (c.refused) return { ok: false, error: c.refused };
  let rec = c.record;
  holdSends(file, { pending: true, until });
  const lock = lockFile(file);
  const save = (patch) => { rec = { ...rec, ...patch }; writeJson(lock, rec); };
  const where = () => ({ pane: rec.pane, ...(rec.name ? { name: rec.name } : {}) });
  // Nothing was stopped: no answer, so the owner may retry the same request (with force).
  const abandon = (code, message) => { releaseRelaunch(file, rec, null, false); endHold(file, 'kept'); return { ok: false, error: { code, message }, ...where() }; };
  const finish = (state, result) => { rec.state = state; releaseRelaunch(file, rec, result, true); endHold(file, state); rediscover(); return result; };
  if (rec.state === 'checking') {
    // A Pi that an earlier relaunch signalled is still exiting: never signal it again.
    if (stopFence(file)) return abandon('stop_pending', 'Pi got the stop signal and has not exited yet');
    const i = await inspectPane(msg, file);
    if (i.error) return abandon(...i.error);
    if (!msg.force && (i.activity !== 'idle' || i.queued)) return abandon('busy', i.queued && i.activity === 'idle' ? `Pi holds ${i.queued} queued message${i.queued === 1 ? '' : 's'}` : `Pi is ${i.activity === 'compacting' ? 'compacting' : 'running a turn'}`);
    if (!msg.force && !i.editorEmpty) return abandon('editor_not_empty', "The Pi pane's input box has text, or AmPi cannot read it");
    if (left() < relaunchStopMs + agentStartMs + 10_000) return abandon('host_slow', 'too little time was left to relaunch Pi safely');
    const oldNonce = i.control?.descriptor.nonce ?? null;
    holdSends(file, { oldNonce, oldPid: i.pid, until });
    // The queue and the file size right before the stop: what reached the file afterwards was delivered.
    // The size first: a message written between the two reads lands after `size`, so it counts as delivered.
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    const now = i.control ? await probe(i.control.descriptor) : null;
    const queued = (now?.value?.submissions ?? []).filter((s) => s?.state === 'queued' && typeof s.submission === 'string')
      .map((s) => ({ submission: s.submission, text: String(s.text ?? ''), ...(s.expanded || s.truncated ? { expanded: true } : {}) }));
    save({ state: 'stopping', name: i.agent.name || herdrName(i.agent.label || path.basename(file, '.jsonl')), pid: i.pid, start: i.start, oldNonce, size, queued, dropped: i.dropped });
    try { process.kill(i.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') return abandon('stop_failed', `AmPi could not signal Pi: ${e.code || e.message}`); }
  } else holdSends(file, { oldNonce: rec.oldNonce ?? null, oldPid: rec.pid, until });
  if (rec.state === 'stopping') {
    // Never signal again: wait for the recorded process (same pid and start time) to exit and its control to close.
    const gone = await waitFor(async () => !await sameProcess(rec.pid, rec.start) && !liveDescriptorFor(file), Math.max(0, Math.min(relaunchStopMs, left())));
    if (!gone) {
      // The signal was sent, so this is an outcome: answer it (a retry never signals again), fence the exiting Pi,
      // and refuse the held sends. Its queue may be lost.
      stopFences.set(file, { pid: rec.pid });
      return finish('stop_timeout', { ok: false, error: { code: 'stop_timeout', message: `Pi got the stop signal but did not exit in ${Math.round(relaunchStopMs / 1000)} s; AmPi started nothing` }, ...where(), stopped: { pid: rec.pid, signal: 'SIGTERM' } });
    }
    save({ state: 'stopped', ...settleQueued(file, rec) });
  }
  const stopped = { pid: rec.pid, signal: 'SIGTERM' };
  const outcome = () => ({ stopped, returned: rec.returned ?? [], delivered: rec.delivered ?? [], ...(rec.dropped?.length ? { dropped: rec.dropped } : {}) });
  if (rec.state === 'stopped') {
    // Two-writer guard, right before the start: no live control names the file, and no Pi runs in the pane.
    if (liveDescriptorFor(file)) return finish('refused', { ok: false, error: { code: 'already_running', message: 'another Pi opened this Session while it was stopped; AmPi started nothing' }, ...where(), ...outcome() });
    const info = await herdrCall(['pane', 'process-info', '--pane', rec.pane], 5000);
    const fg = info.value?.process_info?.foreground_processes;
    if (Array.isArray(fg) && fg.some((x) => typeof x?.argv0 === 'string' && path.basename(x.argv0) === 'pi'))
      return finish('refused', { ok: false, error: { code: 'already_running', message: 'a Pi runs in the pane again; AmPi started nothing' }, ...where(), ...outcome() });
    if (left() < agentStartMs + 5000) {
      // The lock stays at `stopped`: a retry of this request starts Pi.
      endHold(file, 'stopped');
      return { ok: false, error: { code: 'start_deferred', message: 'Pi stopped, but too little time was left to start it; a retry of this request starts it' }, ...where(), ...outcome() };
    }
    save({ state: 'starting' });
    const start = await startInPane(rec.name, rec.pane, ['--session', file], Math.max(0, Math.min(shellReadyMs, left() - agentStartMs - 5000)));
    if (start.error && START_REFUSALS.includes(start.error.code)) {
      const cause = start.error.code === 'agent_pane_busy' ? 'the pane did not return to a shell prompt' : `${start.error.code}: ${start.error.message}`;
      return finish('refused', { ok: false, error: { code: 'start_refused', message: `Pi stopped, but Herdr did not start it again: ${cause}`.slice(0, 300) }, ...where(), ...outcome() });
    }
    const ctl = rec.oldNonce ? await newControl(file, rec.oldNonce, Math.max(0, Math.min(relaunchControlMs, left() - 1000))) : null;
    const evidence = start.error || (rec.oldNonce && !ctl) ? 'unknown' : 'started';
    const fact = start.error ? `${start.error.code}: ${start.error.message}` : rec.oldNonce && !ctl ? 'Herdr started Pi, but its control socket did not answer' : '';
    return finish(evidence, { ok: true, evidence, ...where(), ...outcome(), ...(ctl ? { nonce: ctl.descriptor.nonce } : {}), ...(fact ? { warning: fact.slice(0, 300) } : {}) });
  }
  // `starting`: an earlier run asked Herdr to start Pi; its outcome is unknown. Never start a second Pi.
  const ctl = await newControl(file, rec.oldNonce ?? null, Math.max(0, Math.min(2000, left())));
  if (ctl) return finish('started', { ok: true, evidence: 'started', ...where(), ...outcome(), nonce: ctl.descriptor.nonce });
  return finish('unknown', { ok: false, error: { code: 'outcome_unknown', message: 'an earlier attempt may have started Pi in the pane; check the pane, and Resume if it shows a shell' }, ...where(), ...outcome() });
}

// The self-contained bundle owns service discovery; this agent only relays frames.
function loadArc(bundle, known) {
  if (quitting) return;
  if (arcRelay) return arcRelay;
  return arcRelay = import('data:text/javascript;base64,' + Buffer.from(bundle).toString('base64')).then(m => quitting ? null : m.relay(bundle, { host: cfg.host || os.hostname(), agentDir, known: known || {}, emit: out })).catch(e => { out({ t: 'arc.error', detail: String(e?.message || e) }); return null; });
}
if (cfg.arcBundle) loadArc(cfg.arcBundle, cfg.arcKnown);
async function command(msg) {
  if (msg.t === 'arc.bundle') { if (typeof msg.bundle === 'string') await loadArc(msg.bundle, msg.known); return; }
  if (msg.t === 'arc.request') { const relay = await arcRelay; if (relay) return relay.command(msg); out({ t: 'arc.ack', requestId: msg.requestId, result: { outcome: 'unknown' } }); return; }
  if (msg.t === 'forget') {
    const p = msg.path;
    if (typeof p !== 'string' || !tracked.has(p) && !forgotten.has(p)) return fail(msg, null, 'source_unknown', 'Source is not tracked; keep the local copy');
    if (lastAgents.some(a => a.session === p && (a.pane || a.control?.live))) return fail(msg, null, 'source_live', 'Session is live');
    let st;
    try { st = fs.statSync(p); } catch { return fail(msg, null, 'source_missing', 'Original is unavailable; keep the local evidence'); }
    if (msg.bytes !== st.size || msg.watermark && (msg.watermark.size !== st.size || msg.watermark.mtimeMs !== st.mtimeMs)) return fail(msg, null, 'source_changed', 'Source changed; refresh before eviction');
    forgotten.set(p, { size: st.size, mtimeMs: st.mtimeMs });
    tracked.delete(p); delete offsets[p]; sessionIds.delete(p);
    return ackOf(msg, null, { ok: true, evidence: 'untracked', watermark: { size: st.size, mtimeMs: st.mtimeMs } });
  }
  if (msg.t === 'watch') { watched = new Set(msg.panes || []); return; }
  if (msg.t === 'submit') return submit(msg);
  if (msg.t === 'abort') return abort(msg);
  if (msg.t === 'commands') return viaCommandControl(msg, { op: 'commands' });
  if (msg.t === 'command') return slashCommand(msg);
  if (msg.t === 'screen') return screen(msg);
  if (msg.t === 'spawn') return spawnAgent(msg);
  if (msg.t === 'close') return closePane(msg);
  if (msg.t === 'relaunch') return relaunch(msg);
  if (msg.id !== undefined) fail(msg, null, 'unknown_command', `unknown command ${String(msg.t).slice(0, 40)}`);
}
let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i); inBuf = inBuf.slice(i + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    command(msg).catch((e) => { if (msg.id !== undefined) fail(msg, null, 'internal', String(e?.message || e)); });
  }
});
process.stdin.on('end', () => quit(0, 'stdin end; the hub closed'));

function liveTail() {
  if (!herdr || !sessionReady) return;
  for (const a of lastAgents) {
    if (!a.pane || !watched.has(a.pane)) continue;
    const active = a.status === 'working' || a.status === 'blocked' || Date.now() < (forceUntil.get(a.pane) || 0);
    if (!active) {
      if (liveLast.get(a.pane)) { liveLast.set(a.pane, ''); out({ t: 'live', pane: a.pane, session: a.session, text: '', at: Date.now() }); }
      continue;
    }
    runHerdr(['agent', 'read', a.pane, '--source', 'visible'], { timeout: 3000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return;
      let text = stdout;
      try { const j = JSON.parse(stdout); text = j.result?.text ?? j.result?.output ?? stdout; } catch {}
      if (liveLast.get(a.pane) === text) return;
      liveLast.set(a.pane, text);
      out({ t: 'live', pane: a.pane, session: a.session, text, at: Date.now() });
    });
  }
}

// ---- optional Team view: Pi Team Bright's public observation contract, only if installed here ----
// Pi lists installed packages in settings.json; accept only the package named @hypercarrier/pi-team-bright.
function ptbObservationFile() {
  if (cfg.ptbObservation) return cfg.ptbObservation;
  let pkgs = [];
  try { pkgs = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).packages || []; } catch {}
  for (const p of pkgs) {
    const src = typeof p === 'string' ? p : p?.source;
    if (typeof src !== 'string') continue;
    const root = src.startsWith('npm:') ? path.join(agentDir, 'npm/node_modules', src.slice(4).replace(/(.)@[^/]*$/, '$1'))
      : /^\w+:/.test(src) ? null : path.resolve(agentDir, src.replace(/^~(?=\/)/, os.homedir()));
    if (!root) continue;
    try { if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name !== '@hypercarrier/pi-team-bright') continue; } catch { continue; }
    const f = path.join(root, 'dist/public/observation.js');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
let ptb; // undefined: not loaded yet; null: not installed on this host
let teamOf = new Map(); // pane -> { pane, session, team, member, role }
let recorded = [], teamTasks = {}; // recorded Memberships and public Task observations, independent of live panes
let teamsBusy = false, teamsSent = '', goodAt = 0; // goodAt: time of the last applied snapshot
// Same join rule as tools/pi-teams-hierarchy: exact herdr pane + exact Session path, current, exactly one match.
async function readTeams() {
  if (teamsBusy || cfg.teams === false) return;
  teamsBusy = true;
  try {
    if (ptb === undefined) {
      const f = ptbObservationFile();
      ptb = f ? await import(require('url').pathToFileURL(f).href).catch(() => null) : null;
    }
    if (!ptb?.readObservationSnapshot) return report('absent');
    const snap = await ptb.readObservationSnapshot({ deadlineMs: 1000 });
    if (snap?.schema !== 'pi-teams-observation/1') return report('error', [`schema ${String(snap?.schema).slice(0, 40)}`]);
    const codes = [...new Set(snap.issues.map((i) => i.code))];
    if (snap.availability === 'unavailable') return report('unavailable', codes); // absence is not evidence: keep the last view
    const nextRecorded = [], nextTasks = {};
    for (const team of snap.teams) {
      let tasks = [], taskAvailability = 'unavailable', issues = (team.issues ?? []).map(i => i.code);
      if (!ptb.readTaskSnapshot) issues.push('task_reader_missing');
      else {
        try {
          const read = await ptb.readTaskSnapshot({ teamName: team.teamName, deadlineMs: 1000 });
          if (read?.schema !== 'pi-team-tasks/1' || read.teamName !== team.teamName) issues.push('task_schema_unsupported');
          else if (read.availability !== 'available') issues.push(...(read.issues?.length ? read.issues : ['task_authority_unavailable']));
          else { tasks = read.tasks; taskAvailability = 'available'; }
        } catch { issues.push('task_read_failed'); }
      }
      const members = team.memberships.map(m => ({ team: team.teamName, member: m.memberName, role: m.coordinationRole,
        ...(m.session?.kind === 'pi-jsonl-path' ? { session: m.session.locator } : {}),
        ...(m.terminalTarget?.backend === 'herdr' && m.terminalTarget.kind === 'pane' ? { pane: m.terminalTarget.targetId } : {}) }));
      for (const m of members) if (m.session) track(m.session);
      nextRecorded.push(...members);
      nextTasks[team.teamName] = { availability: taskAvailability, tasks, issues: [...new Set(issues)] };
    }
    if (snap.availability === 'partial') for (const name of Object.keys(teamTasks)) {
      if (!nextTasks[name]) {
        nextRecorded.push(...recorded.filter(m => m.team === name));
        nextTasks[name] = { availability: 'unavailable', tasks: [], issues: ['task_membership_read_partial'] };
      }
    }
    recorded = nextRecorded; teamTasks = nextTasks;
    const members = snap.teams.flatMap((t) => t.memberships).filter((m) =>
      m.terminalTarget?.backend === 'herdr' && m.terminalTarget.kind === 'pane' && m.session?.kind === 'pi-jsonl-path');
    const next = new Map();
    for (const a of lastAgents) {
      if (!a.pane || !a.session || !a.pi) continue; // herdr detected a Pi agent with an exact Session path
      const exact = members.filter((m) => m.terminalTarget.targetId === a.pane && m.session.locator === a.session);
      const cur = exact.filter((m) => m.lifecycle?.state === 'current');
      const prev = teamOf.get(a.pane);
      if (cur.length === 1) next.set(a.pane, { pane: a.pane, session: a.session, membership: cur[0].membershipId, team: cur[0].teamName, member: cur[0].memberName, role: cur[0].coordinationRole });
      // A partial snapshot cannot clear a label by absence; an ended exact Membership or a new Session can.
      else if (snap.availability === 'partial' && prev?.session === a.session && cur.length === 0 && !exact.length) next.set(a.pane, prev);
      else if (cur.length > 1 && prev?.session === a.session) next.set(a.pane, prev); // ambiguous: unchanged
    }
    teamOf = next; goodAt = Date.now();
    report(snap.availability, codes);
  } catch (e) { report('error', [String(e?.message || e).slice(0, 120)]); } finally { teamsBusy = false; }
}
// status: absent (not installed) | available | partial | unavailable | error. Members keep the last good join.
function report(status, codes = []) {
  const msg = { t: 'teams', status, codes, members: [...teamOf.values()], recorded, tasks: teamTasks };
  const key = JSON.stringify(msg); // goodAt moves on every good read; it rides along but never triggers a send
  if (key !== teamsSent) { teamsSent = key; out({ ...msg, goodAt, at: Date.now() }); }
}

// ---- model limits: context windows and the Auto Compact working budget, as Pi and hc-hud resolve them ----
// Windows layer as Pi's model registry does: refreshed provider catalogs (models-store.json), then models.json
// `models` entries, then models.json `modelOverrides`. Built-in catalogs never refreshed here and extension
// providers are not visible. Sent only when the files change.
// The Auto Compact budget is hc-auto-compact's own resolution (resolve.mjs), which the hub sends as a data: module
// (cfg.autoCompactResolve; apps/ampi/src/pi/agent-modules.ts). Each file's stamp is `mtime:size`, or `-` when it is
// absent, as AmPi's fileStamp (src/shared/pi-config.ts).
let limitsKey = '', limitsSent = '', resolveAutoCompact = null;
function readLimits() {
  const files = ['models-store.json', 'models.json', 'settings.json'].map((f) => path.join(agentDir, f));
  const key = files.map((f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');
  if (key === limitsKey) return;
  limitsKey = key;
  const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  const [store, models, settings] = files.map(json);
  const windows = {};
  const put = (provider, id, n) => { if (typeof id === 'string' && Number.isSafeInteger(n) && n > 0) windows[`${provider}/${id}`] = n; };
  for (const [provider, p] of Object.entries(store || {})) for (const m of p?.models || []) put(provider, m?.id, m?.contextWindow);
  for (const [provider, p] of Object.entries(models?.providers || {})) {
    for (const m of p?.models || []) put(provider, m?.id, m?.contextWindow);
    for (const [id, o] of Object.entries(p?.modelOverrides || {})) put(provider, id, o?.contextWindow);
  }
  // The global settings only: project settings apply to trusted projects, which this agent does not resolve.
  // Without a budget the meter measures against the window.
  const ac = resolveAutoCompact?.(settings).settings;
  const perModel = Object.fromEntries(Object.entries(ac?.modelOverrides || {}).map(([k, v]) => [k, v.budget_tokens]));
  const budget = ac?.budget_tokens !== undefined || Object.keys(perModel).length ? { tokens: ac.budget_tokens, models: perModel } : null;
  const msg = { t: 'limits', windows, budget };
  const sent = JSON.stringify(msg);
  if (sent !== limitsSent) { limitsSent = sent; out({ ...msg, at: Date.now() }); }
}

if (tracing) traceEvents.push({ ph: 'i', s: 'p', name: 'hello', cat: 'startup', ts: traceNow(), pid: process.pid, tid: 0 });
out({ t: 'hello', host: cfg.host || os.hostname(), pid: process.pid, herdr: !!herdr, herdrSession, control: (() => { try { return fs.readdirSync(controlDir).some((f) => f.endsWith('.json')); } catch { return false; } })(), at: Date.now() });
for (const p of Object.keys(offsets)) track(p);
discover();
setInterval(discover, discoverMs);
// Limits start once the resolver loads. A resolver that fails to load leaves the meter on the window, and says why.
import(cfg.autoCompactResolve).then((m) => { resolveAutoCompact = m.resolveAutoCompactSettings; }, (error) => {
  process.stderr.write(`hc-auto-compact resolver: ${error?.message || error}\n`);
}).then(() => { readLimits(); setInterval(readLimits, discoverMs); });
setInterval(pump, pollMs);
setInterval(liveTail, 1000);
setTimeout(readTeams, 1500); // after the first agent list
setInterval(readTeams, cfg.teamsMs ?? 5000);
setInterval(() => out({ t: 'beat', at: Date.now() }), 5000);
