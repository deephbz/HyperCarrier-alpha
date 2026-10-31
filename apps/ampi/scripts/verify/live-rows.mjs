// Rows h, i and l, one rule owner: every Herdr Pi pane is a live Session row, the Host agent stays up, and the Host
// links pass linkWatch: no build failure, and every link that was up before the restart, or is new, connects.
// Drivers:
//   - journey H (journeys.mjs) and agent-recovery.ts: the disposable demo hub and its fake Herdr, strict;
//   - scripts/smoke-live.mjs (hc-lenses, deploy owner): the live hub and the real `herdr agent list`.
// This module reads only what a driver passes in. It never finds a hub, a key, or a port on its own.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename } from 'node:path';

// deploy-live.sh runs a copy of this module from a temp directory, so `ws` may resolve only from the checkout cwd.
// Only the threads snapshot needs it; the link list that the deploy saves before the restart runs without it.
const loadWs = () => { try { return createRequire(import.meta.url)('ws'); } catch { return createRequire(process.cwd() + '/package.json')('ws'); } };

/**
 * One threads-topic snapshot, read like a tool would. `auth` is either { bearer } or { cookie }; neither is ever
 * printed. Resolves the Session rows as an array.
 */
export async function threadsSnapshot({ port, host, auth, timeoutMs = 5000 }) {
  const threads = (await topicSnapshot({ port, host, auth, topic: { kind: 'threads' }, timeoutMs })).threads;
  return Array.isArray(threads) ? threads : Object.values(threads ?? {});
}

/** One snapshot of any hub topic (for example { kind: 'view', view: 'cos.timeline' }), read the same way. */
export function topicSnapshot({ port, host, auth, topic, timeoutMs = 5000 }) {
  return new Promise((done, fail) => {
    const headers = auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : { cookie: auth.cookie, origin: `http://127.0.0.1:${port}` };
    const WebSocket = loadWs();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const timer = setTimeout(() => { ws.terminate(); fail(new Error(`${topic.view ?? topic.kind} snapshot timed out`)); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'sub', sid: 1, host, topic })));
    ws.on('message', data => {
      const f = JSON.parse(String(data));
      if (f.sid !== 1) return;
      if (f.t === 'end') { clearTimeout(timer); ws.close(); fail(new Error(`${topic.view ?? topic.kind} subscription ended: ${f.reason}`)); return; }
      if (f.t !== 'snap') return;
      clearTimeout(timer); ws.close();
      done(f.value);
    });
    ws.on('error', e => { clearTimeout(timer); fail(e); });
  });
}

/**
 * Row h: each Herdr Pi agent ({ pane_id, agent_status }) against the Session rows.
 * A pane passes when a live row has it as location.pane. With `activity`, Herdr working must not show idle and
 * Herdr idle must show idle. Returns the per-pane problems and whether at most `missingShare` of panes fail.
 */
export function paneCoverage(agents, threads, { activity = true, missingShare = 0 } = {}) {
  const rows = agents.map(a => {
    const t = threads.find(t => t.location?.pane === a.pane_id);
    const problem = !t ? 'missing' : !t.live ? 'not live'
      : activity && a.agent_status === 'working' && t.activity === 'idle' ? 'busy shown idle'
      : activity && a.agent_status === 'idle' && t.activity !== 'idle' ? `idle shown ${t.activity}` : null;
    return { pane: a.pane_id, herdr: a.agent_status, thread: t?.id ?? null, activity: t?.activity ?? null, problem };
  });
  const problems = rows.filter(r => r.problem);
  return {
    herdrPi: agents.length,
    matched: agents.length - problems.length,
    liveThreads: threads.filter(t => t.live).length,
    problems,
    ok: problems.length <= Math.floor(agents.length * missingShare),
  };
}

/** Pi agents from a real `herdr agent list` (deploy driver). */
export function herdrAgentList(bin = 'herdr') {
  return JSON.parse(execFileSync(bin, ['agent', 'list'], { encoding: 'utf8', timeout: 10_000 })).result.agents.filter(a => a.agent === 'pi');
}

/** Row i: pids of the hub's local remote agents (direct children running the agent bootstrap). */
export function agentPids(hubPid) {
  const ps = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return agentPidsFromPS(ps, hubPid);
}

/** Parse only direct Node bootstrap children. Absolute execPath and PATH-resolved node are equivalent. */
export function agentPidsFromPS(ps, hubPid) {
  return ps.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[1] === String(hubPid)
    && p[2] && (p[2] === process.execPath || basename(p[2]) === 'node')
    && p[3] === '-e' && p[4]?.startsWith('eval(Buffer')).map(p => Number(p[0])).sort((a, b) => a - b);
}

/**
 * Row l: a sampler of the hub's Host links (`/api/health` hosts) after a restart, judged against `before`, the hosts
 * that the old hub listed (null when the old hub did not answer). A link fails the row when:
 * - its last status is not connected and its error is a build failure (errorClass build, as src/hub/hosts.ts
 *   ErrorClass defines), whatever it was before: a stale pinned package dist keeps every durable link out;
 * - it never connects in the window, and it was connected before, or the old hub did not list it;
 * - it was connected before and the new hub does not list it.
 * A link that never connects, was not connected before, and ends with a reachability failure is a note: its Host was
 * down before the deploy too. Without `before` every such link is a note, and only build failures fail.
 */
export function linkWatch(before = null) {
  const links = new Map();
  const was = before && new Map(before.map((h) => [h.link ?? h.id, h.status]));
  const state = ({ status, phase, error }) => `${status}${phase ? `/${phase}` : ''}${error ? `: ${String(error).slice(0, 200)}` : ''}`;
  const judge = () => {
    const failed = [], notes = [];
    for (const [key, { ever, last }] of links) {
      const up = was?.get(key) === 'connected', unlisted = was && !was.has(key);
      if (last.status !== 'connected' && last.errorClass === 'build') failed.push(`${key} ${state(last)} (build failure)`);
      else if (ever) continue;
      else if (up) failed.push(`${key} ${state(last)} (connected before the restart)`);
      else if (unlisted) failed.push(`${key} ${state(last)} (new link)`);
      else notes.push(`${key} ${state(last)} (${was ? 'not connected before the restart either' : 'no list from the old hub'})`);
    }
    for (const [key, status] of was ?? []) if (status === 'connected' && !links.has(key)) failed.push(`${key} not listed after the restart (connected before)`);
    return { failed, notes };
  };
  return {
    sample(hosts) {
      for (const h of hosts ?? []) {
        const key = h.link ?? h.id;
        links.set(key, { ever: Boolean(links.get(key)?.ever) || h.status === 'connected', last: h });
      }
    },
    get count() { return links.size; },
    /** `<link> <status>[/<phase>][: <error>] (<reason>)` for each link that fails the row. */
    get failed() { return judge().failed; },
    /** The same shape for each link that is down but does not fail the row. */
    get notes() { return judge().notes; },
  };
}

/**
 * Row i: a sampler of agent pids. It starts at the first sample that finds an agent; `restarts` counts every later
 * change of the pid set, an empty set (agent down) included.
 */
export function agentWatch(hubPid) {
  const seen = [];
  return {
    sample() { const pids = agentPids(hubPid).join(','); if ((seen.length || pids) && seen.at(-1) !== pids) seen.push(pids); return pids; },
    get restarts() { return Math.max(0, seen.length - 1); },
    get history() { return [...seen]; },
  };
}
