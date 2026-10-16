// Session mirror remote agent. Sent inline over SSH; nothing is installed.
// Owns discovery, JSONL transfer and Herdr command forwarding on the remote host.
// Discovers Pi Session files through `herdr agent list` (fallback: recent files under
// ~/.pi/agent/sessions) and pushes appended JSONL bytes to stdout as framed JSON lines.
// Reads/updates are pushed. The same channel's stdin carries write commands:
//   {t:'prompt', id, pane, text}  -> herdr agent prompt   -> {t:'ack', id, ok, error}
//   {t:'keys', id, pane, keys}    -> herdr agent send-keys (interrupt = ['esc']) -> {t:'ack', ...}
//   {t:'screen', id, pane, ms}    -> stream that pane's screen for ms, even when idle -> {t:'ack', ...}
//   {t:'watch', panes:[...]}      -> live screen of watched panes while working, blocked or forced -> {t:'live', pane, text}
// Unless teams are off, it also pushes {t:'teams', status, codes, goodAt, members:[{pane, session, membership, team, member, role}]} on change.
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const os = require('os');

const cfg = JSON.parse(Buffer.from(process.env.HCM_CFG || 'e30=', 'base64').toString());
const offsets = cfg.offsets || {}; // path -> byte offset already mirrored locally
const tailBytes = cfg.tailBytes || 0; // 0 = mirror the whole Session
const pollMs = cfg.pollMs ?? 250;
const discoverMs = cfg.discoverMs ?? 2000;
const maxChunk = 1_000_000;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const tracked = new Map(); // path -> { offset }

function herdrBin() {
  for (const p of [process.env.HERDR_BIN, 'herdr', path.join(os.homedir(), '.local/bin/herdr')]) {
    if (!p) continue;
    try { cp.execFileSync(p, ['--version'], { stdio: 'ignore', timeout: 3000 }); return p; } catch {}
  }
  return null;
}
const herdr = herdrBin();
const herdrSession = cfg.herdrSession || 'default';
const scoped = (argv) => ['--session', herdrSession, ...argv];
let sessionReady = false, checking;
// A scoped CLI call can create a missing server. Every retry starts with this list.
function checkSession() {
  if (!herdr) return Promise.resolve(false);
  checking ||= new Promise((resolve) => cp.execFile(herdr, ['session', 'list', '--json'], { timeout: 3000 }, (err, stdout) => {
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
  cp.execFile(herdr, scoped(argv), options, (err, stdout, stderr) => {
    if (err) { sessionReady = false; out({ t: 'status', state: 'Herdr session check required', at: Date.now() }); }
    cb(err, stdout, stderr);
  });
}

function track(p) {
  if (tracked.has(p)) return;
  let size = 0;
  try { size = fs.statSync(p).size; } catch { return; }
  let offset = offsets[p];
  let truncatedHead = false;
  if (offset === undefined || offset > size) {
    offset = tailBytes ? Math.max(0, size - tailBytes) : 0;
    if (offset > 0) {
      // Align the start to a line boundary so every mirrored line parses.
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(65536, size - offset));
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      const nl = buf.indexOf(10);
      offset = nl < 0 ? size : offset + nl + 1;
      truncatedHead = true;
    }
    out({ t: 'reset', path: p, offset, truncatedHead });
  }
  tracked.set(p, { offset });
}

function pump() {
  for (const [p, st] of tracked) {
    let size;
    try { size = fs.statSync(p).size; } catch { continue; }
    if (size < st.offset) { st.offset = 0; out({ t: 'reset', path: p, offset: 0, truncatedHead: false }); }
    while (size > st.offset) {
      // One entry can exceed maxChunk (an image read is several MB): grow the read until it
      // holds a whole line, or the file ends inside an unfinished line.
      let len = Math.min(maxChunk, size - st.offset), buf, last;
      for (;;) {
        buf = Buffer.alloc(len);
        const fd = fs.openSync(p, 'r');
        fs.readSync(fd, buf, 0, len, st.offset);
        fs.closeSync(fd);
        last = buf.lastIndexOf(10);
        if (last >= 0 || len === size - st.offset) break;
        len = Math.min(len * 2, size - st.offset);
      }
      if (last < 0) break; // partial line; wait for the writer to finish it
      out({ t: 'chunk', path: p, offset: st.offset, data: buf.subarray(0, last + 1).toString('utf8') });
      st.offset += last + 1;
    }
  }
}

function fallbackAgents() {
  const root = path.join(os.homedir(), '.pi/agent/sessions');
  const cutoff = Date.now() - 6 * 3600_000;
  const agents = [];
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, d);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (m > cutoff) agents.push({ session: p, title: f, status: 'unknown', source: 'mtime' });
    }
  }
  return agents;
}

let discovering = false;
async function discover() {
  if (discovering) return;
  discovering = true;
  try {
  const done = (agents) => {
    lastAgents = agents;
    for (const a of agents) {
      track(a.session);
      try { a.bytes = fs.statSync(a.session).size; } catch {} // lets the hub detect a stalled copy
    }
    out({ t: 'agents', at: Date.now(), source: herdr ? 'herdr' : 'mtime', agents, labels });
  };
  // Tab and workspace labels let local clients reproduce the remote layout.
  const labels = {};
  if (!herdr) return done(fallbackAgents());
  if (!await checkSession()) return done([]);
  for (const kind of ['tab', 'workspace']) {
    await new Promise((resolve) => runHerdr([kind, 'list'], { timeout: 3000 }, (err, stdout) => {
      try { if (!err) for (const x of JSON.parse(stdout).result[kind + 's']) labels[x[kind + '_id']] = x.label; } catch {}
      resolve();
    }));
  }
  await new Promise((resolve) => runHerdr(['agent', 'list'], { timeout: 5000, maxBuffer: 32 << 20 }, (err, stdout) => {
    resolve();
    if (err) return done([]);
    try {
      const list = JSON.parse(stdout).result.agents;
      done(list.filter((a) => a.agent_session?.kind === 'path').map((a) => ({
        session: a.agent_session.value,
        pane: a.pane_id, workspace: a.workspace_id, tab: a.tab_id,
        name: a.name, title: a.terminal_title_stripped, cwd: a.cwd,
        status: a.agent_status, focused: a.focused, tokens: a.tokens || {},
        source: 'herdr', pi: a.agent === 'pi' && a.agent_session.agent === 'pi',
      })));
    } catch { done([]); }
  }));
  } finally { discovering = false; }
}

// ---- write path and live screen tail ----
let watched = new Set();
const liveLast = new Map();
const forceUntil = new Map(); // pane -> time until which the screen streams regardless of status
let lastAgents = [];

async function command(msg) {
  if (msg.t === 'watch') { watched = new Set(msg.panes || []); return; }
  if (!herdr) return out({ t: 'ack', id: msg.id, ok: false, error: 'herdr not found on remote' });
  const ack = (err, stdout, stderr) =>
    out({ t: 'ack', id: msg.id, ok: !err, error: err ? String(stderr || stdout || err.message).trim().slice(0, 500) : undefined, at: Date.now() });
  if (!await checkSession()) return ack(new Error('Herdr session not running'));
  // Recheck the exact binding on the named server. Never infer it from a pane ID.
  runHerdr(['agent', 'get', msg.pane], { timeout: 5000 }, (err, stdout) => {
    let a;
    try { a = JSON.parse(stdout).result.agent; } catch {}
    if (err || a?.agent_session?.kind !== 'path' || a.agent_session.value !== msg.session) return ack(new Error('pane Session binding changed'));
    if (msg.t === 'screen') { forceUntil.set(msg.pane, Date.now() + msg.ms); liveTail(); return ack(); }
    if (msg.t === 'keys') {
      if (a.agent_status !== 'working') return ack(new Error('agent is not working'));
      return runHerdr(['agent', 'send-keys', msg.pane, ...msg.keys], { timeout: 15000 }, ack);
    }
    if (msg.t === 'prompt') {
      if (msg.text.trim().startsWith('/')) forceUntil.set(msg.pane, Date.now() + 15000);
      runHerdr(['agent', 'prompt', msg.pane, msg.text], { timeout: 15000 }, ack);
    }
  });
}
let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i); inBuf = inBuf.slice(i + 1);
    try { command(JSON.parse(line)).catch(() => {}); } catch {}
  }
});
process.stdin.on('end', () => process.exit(0));

function liveTail() {
  if (!herdr || !sessionReady) return;
  for (const a of lastAgents) {
    if (!watched.has(a.pane)) continue;
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
  const agentDir = path.join(os.homedir(), '.pi/agent');
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
  const msg = { t: 'teams', status, codes, members: [...teamOf.values()] };
  const key = JSON.stringify(msg); // goodAt moves on every good read; it rides along but never triggers a send
  if (key !== teamsSent) { teamsSent = key; out({ ...msg, goodAt, at: Date.now() }); }
}

out({ t: 'hello', host: os.hostname(), pid: process.pid, herdr: !!herdr, herdrSession, at: Date.now() });
for (const p of Object.keys(offsets)) track(p);
discover();
setInterval(discover, discoverMs);
setInterval(pump, pollMs);
setInterval(liveTail, 1000);
setTimeout(readTeams, 1500); // after the first agent list
setInterval(readTeams, cfg.teamsMs ?? 5000);
setInterval(() => out({ t: 'beat', at: Date.now() }), 5000);
process.stdout.on('error', () => process.exit(0));
