// Browser-only fixture adapter. No UI request is ever forwarded to the hub.
// The live demo supplies read-only Pi snapshots. Explicit variants exercise the real UI with synthetic projections.
/** One prompt answered by 300 tool calls: the Session's first prompt, then its first tool call and result 300 times.
 * Copy k reads "step k", so a shot shows which part of the turn is on screen. */
function longTurn(value) {
  const entries = value.entries ?? [], user = entries.find(e => e.kind === 'user'), result = entries.find(e => e.kind === 'tool-result');
  const call = result && entries.find(e => e.kind === 'assistant' && JSON.stringify(e.blocks).includes(`"${result.callId}"`));
  if (!user || !call) return value;
  const copy = k => { let s = JSON.stringify([call, result]); for (const id of [call.id, result.id, result.callId]) s = s.split(`"${id}"`).join(`"${id}-${k}"`); return JSON.parse(s.split('step 0').join(`step ${k}`)); };
  return { ...value, hiddenBefore: false, entries: [user, ...Array.from({ length: 300 }, (_, k) => copy(k)).flat()] };
}

/**
 * Values the hub reads from its own clock or measures at run time, by path in a frame payload (`*` is any key or
 * index). A scene shows them at the page clock, so a scene shows the same values on every run.
 */
const HUB_CLOCK = {
  hosts: ['*.connectedAt', '*.since', '*.retryAt', '*.lastSeen', '*.latencyMs'],
  threads: ['threads.*.arc.builtAt'],
  thread: ['agent.asOf', 'live.retry.at'],
  view: ['source.asOf', 'diagnosis.ms', 'keptAt', 'context.builtAt', 'synthesis.builtAt', 'builds.*.startedAt', 'builds.*.endedAt',
    'arcBuilds.*.startedAt', 'arcBuilds.*.endedAt', 'sessions.*.source.asOf', 'sessions.*.head.builtAt'],
};
/** Measured durations show these synthetic values; every other hub-clock value shows the page clock. */
const MEASURED = { latencyMs: 24, ms: 12 };
/** Pins the HUB_CLOCK values of one frame payload to a fixed page clock. On the wall clock (`clock` undefined) the hub's
 * values already agree with the page, and the payload passes unchanged. */
export function pinHubClock(kind, value, clock) {
  if (clock === undefined) return value;
  const pin = (node, [key, ...rest]) => {
    if (!node || typeof node !== 'object') return;
    for (const k of key === '*' ? Object.keys(node) : [key]) {
      if (!(k in node)) continue;
      if (rest.length) pin(node[k], rest);
      else node[k] = k in MEASURED ? MEASURED[k] : typeof node[k] === 'string' ? new Date(clock).toISOString() : typeof node[k] === 'number' ? clock : node[k];
    }
  };
  for (const path of HUB_CLOCK[kind] ?? []) pin(value, path.split('.'));
  return value;
}

/**
 * Routes the page's hub link through the browser fixture, the one way to install it. With `clock` (epoch ms) it fixes
 * the page clock at that value, dates the fixture's own replies by it, and pins every hub-clock value to it
 * (HUB_CLOCK), so a scene shows the same values on every run. Without `clock` the page, the hub and the fixture all
 * read the wall clock. `through` wraps the route (a test that reads or rewrites frames).
 */
export async function routeFixture(page, recipe, audit, { clock, through } = {}) {
  if (clock !== undefined) await page.clock.setFixedTime(clock);
  await page.routeWebSocket('**/ws', ws => fixtureSocket(through ? through(ws) : ws, recipe, audit, clock));
}

function fixtureSocket(ws, recipe, audit, clock) {
  const now = () => clock ?? Date.now();
  const server = ws.connectToServer();
  const topics = new Map();
  // The prompt outline of each frozen thread snapshot, so the prompt rail has dashes without a hub request.
  const outlines = new Map();
  const snap = (sid, value) => ws.send(JSON.stringify({ t: 'snap', sid, value }));
  ws.onMessage(raw => {
    const f = JSON.parse(String(raw));
    if (f.t === 'sub') {
      topics.set(f.sid, f.topic);
      return server.send(raw);
    }
    if (f.t === 'unsub') return server.send(raw);
    // The page says its build first; the hub checks it (P1).
    if (f.t === 'hello') return server.send(raw);
    if (!['req', 'hub'].includes(f.t)) throw new Error('Unexpected client frame');
    audit.requests.push({ op: f.op, host: f.host ?? 'hub', disposition: 'browser-fixture-only' });
    const respond = value => ws.send(JSON.stringify({ t: 'res', id: f.id, ok: true, value }));
    const reject = () => ws.send(JSON.stringify({ t: 'res', id: f.id, ok: false, error: { code: 'synthetic_failure', message: 'Synthetic demo failure. No Host action was sent.' } }));
    if (recipe.reject && !['models.list', 'prompts.list', 'thread.history'].includes(f.op)) return reject();
    if (recipe.pending && ['view.rarebit.ask', 'view.arc.build'].includes(f.op)) return;
    switch (f.op) {
      case 'models.list': return respond([]);
      case 'thread.commands': return respond({ commands: [], models: [], model: 'synthetic/offline', thinkingLevels: ['off'] });
      case 'prompts.list': return respond({ prompts: [], skills: [] });
      case 'thread.history': return respond({ entries: [], more: false });
      case 'thread.outline': return outlines.has(f.args.threadId) ? respond(outlines.get(f.args.threadId)) : reject();
      case 'view.rarebit.ask': return respond(f.args.end ? {} : { side: { id: 'synthetic-side', at: new Date(now()).toISOString(), count: 12, included: 12, omittedChars: 0, revision: 1, model: 'synthetic/offline', turns: [{ question: f.args.question, answer: 'Synthetic answer: the reader and GUI fixtures are ready for review.' }] } });

      case 'thread.submit': return respond({ via: 'synthetic', evidence: 'sent' });
      case 'thread.create': case 'thread.resume': return reject(); // Never create or resume even a fake agent.
      default: return respond({});
    }
  });
  server.onMessage(raw => {
    const f = JSON.parse(String(raw));
    if (f.t === 'hosts') {
      for (const h of f.hosts) {
        h.node = { nodeId: 'synthetic-node', hostname: 'synthetic-host', platform: 'synthetic', user: '', home: '/work/demo', version: 'demo', storage: '/work/demo/cache' };
        if (recipe.variant === 'away') h.status = 'disconnected';
      }
      pinHubClock('hosts', f.hosts, clock);
      return ws.send(JSON.stringify(f));
    }
    // Freeze each read snapshot; do not mix new deltas into synthetic variants. A `live` recipe takes the hub's deltas.
    if (f.t !== 'snap') { if (recipe.live && topics.has(f.sid)) ws.send(String(raw)); return; }
    const topic = topics.get(f.sid);
    if (!topic) return;
    const v = recipe.variant;
    if (v === 'loading') return;
    if (v === 'loading-view' && topic.kind === 'view') return;
    if ((v === 'error' && topic.kind !== 'threads') || (v === 'error-view' && topic.kind === 'view')) return ws.send(JSON.stringify({ t: 'end', sid: f.sid, reason: 'Synthetic reader failure. Reconnect to retry.' }));
    let value = f.value;
    if (topic.kind === 'threads') {
      if (v === 'empty') value = { threads: {} };
    }
    if (topic.kind === 'thread') {
      if (v === 'long-turn') value = longTurn(value);
      const entries = value.entries ?? [];
      outlines.set(topic.threadId, { version: value.sourceVersion, totalEntries: entries.length, truncated: false,
        users: entries.flatMap((e, i) => e.kind === 'user' ? [{ id: e.id, ordinal: i, firstLine: String(e.text).split(/\r?\n/, 1)[0].slice(0, 120) }] : []) });
      if (v === 'queued') value.inbox = { items: [{ id: 'synthetic-queue', mode: 'followUp', content: 'Synthetic queued follow-up: verify the next step.' }] };
      if (v === 'retry') { value.live.retry = { at: now(), error: 'Synthetic provider overload' }; value.live.compactions = [{ taskId: 'synthetic-compact', reason: 'working_budget', blocking: true }]; }
    }
    if (topic.kind === 'view') {
      if (v === 'empty' && value.sessions) value.sessions = [];
      if (topic.view === 'team' && value.teams) {
        if (v === 'empty-view') value.teams.forEach(t => { t.tasks = []; });
        if (['tasks-unavailable', 'reader-missing'].includes(v)) value.teams.forEach(t => { t.tasks = []; t.issues = [v === 'reader-missing' ? 'task_reader_missing' : 'task_authority_unavailable']; });
        if (v === 'absent') { value.availability = 'absent'; value.teams = []; }
        if (v === 'partial') value.availability = 'partial';
        if (v === 'no-team') value.teams = [];
        if (v === 'large-team') value.teams.forEach(t => { t.tasks = Array.from({ length: 105 }, (_, i) => ({ id: `U${i}`, title: `Synthetic coverage Task ${i}`, status: 'ready', ready: true, owner: 'reader', deps: [] })); });
      }
      if (topic.view === 'arc' && topic.threadId) {
        if (v === 'missing') value = { stale: 0, branchChanged: false, status: { state: 'failed', error: { code: 'source', message: 'Synthetic Session copy unavailable. Reconnect the Host.' } } };
        if (v === 'empty-view') delete value.receipt;
      }
    }
    snap(f.sid, pinHubClock(topic.kind, value, clock));
    if (v === 'away') ws.send(JSON.stringify({ t: 'stale', sid: f.sid }));
  });
}
