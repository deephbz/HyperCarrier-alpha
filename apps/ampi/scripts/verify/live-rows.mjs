// Rows h and i, one rule owner: every Herdr Pi pane is a live Session row, and the Host agent stays up.
// Drivers:
//   - journey H (journeys.mjs) and agent-recovery.ts: the disposable demo hub and its fake Herdr, strict;
//   - scripts/smoke-live.mjs (hc-lenses, deploy owner): the live hub and the real `herdr agent list`.
// This module reads only what a driver passes in. It never finds a hub, a key, or a port on its own.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// deploy-live.sh runs a copy of this module from a temp directory, so `ws` may resolve only from the checkout cwd.
const WebSocket = (() => { try { return createRequire(import.meta.url)('ws'); } catch { return createRequire(process.cwd() + '/package.json')('ws'); } })();

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
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const timer = setTimeout(() => { ws.terminate(); fail(new Error(`${topic.view ?? topic.kind} snapshot timed out`)); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'sub', sid: 1, host, topic })));
    ws.on('message', data => {
      const f = JSON.parse(String(data));
      if (f.t !== 'snap' || f.sid !== 1) return;
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
  return ps.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p[1] === String(hubPid) && p.slice(2).join(' ').startsWith('node -e eval(Buffer')).map(p => Number(p[0])).sort((a, b) => a - b);
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
