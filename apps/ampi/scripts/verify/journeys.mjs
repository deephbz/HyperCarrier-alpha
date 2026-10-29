// Deterministic journeys, one per feature file in .pi/skills/verify-ampi/features/.
// Each journey drives the real UI against the synthetic demo hub through user paths. Each step returns the
// observed state; the runner adds a screenshot, an ARIA snapshot, and the hub side effects of that step.
// j.gap(incident, ...) marks a known product gap: it must still fail. If it passes, the journey fails so the
// map gets updated.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { thread, timeline, arc } from '../ux/recipes.mjs';
import { threadsSnapshot, topicSnapshot, paneCoverage, agentWatch } from './live-rows.mjs';
import { app, checkout } from './hub.mjs';
import { timelineTeams } from './timeline-teams.mjs';
import { arcFloor } from '../../src/pi/views/cos-arc-rules.ts';

const num = text => Number(String(text).replace(/[^\d]/g, ''));
const sideScroll = p => p.locator('.side-scroll');
// Each sidebar row in order, with its kind and its open or folded state; failure evidence for sidebar layout steps.
const sidebarRows = side => side.evaluate(e => [...e.querySelectorAll('.row')].map(r => ({
  kind: r.matches('.group-row') ? 'group' : r.hasAttribute('data-leader-row') ? 'leader' : r.hasAttribute('data-parent-leader') ? 'worker' : 'row',
  thread: r.getAttribute('data-thread') ?? r.getAttribute('data-sidebar-toggle') ?? undefined,
  label: (r.querySelector('.title') ?? r).textContent.trim().slice(0, 60),
  expanded: (r.querySelector('[data-collapse-toggle]') ?? r).getAttribute('aria-expanded') ?? undefined,
  y: Math.round(r.getBoundingClientRect().top + e.scrollTop - e.getBoundingClientRect().top),
})));
const rbScroll = p => p.locator('.rb-scroll');

/** 20 extra quiet Sessions so Overview cards need a second page. Written only inside the disposable demo dir. */
function addQuietSessions(state, count = 20) {
  const dir = join(state.demo, 'agent/sessions/--work-verify-paging--');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const t = new Date(now - (i + 1) * 60_000).toISOString();
    const id = `sess-verify-quiet-${i}`;
    const rows = [
      { type: 'session', version: 3, id, timestamp: t, cwd: '/work/verify-paging' },
      { type: 'message', id: `${id}-u`, parentId: null, timestamp: t, message: { role: 'user', content: [{ type: 'text', text: `Synthetic quiet Session ${i}` }], timestamp: Date.parse(t) } },
      { type: 'message', id: `${id}-a`, parentId: `${id}-u`, timestamp: t, message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, content: [{ type: 'text', text: 'Done.' }] } },
    ];
    writeFileSync(join(dir, `verify-quiet-${i}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
}

const LIVE_MS = 60_000, STALL_MS = 15_000;

/** The demo hub's threads topic, read with the bearer key like a tool would. */
const threadsOf = state => threadsSnapshot({ port: state.port, host: 'devbox', auth: { bearer: readFileSync(join(state.run, 'hub.key'), 'utf8').trim() } });

/**
 * Startup automatic Builds settled (D16): every Session autoBuild may build at hub start (live, idle, stopped: a
 * cos.timeline row that is waiting, not blocked, at or above the Arc floor, and no Worker) has a current Arc head in the threads topic. Steps that assert
 * no model call wait for it, so the startup Builds' calls never fall inside them. One promise per run.
 */
const settled = new WeakMap();
function autoBuildsSettled(state, ms = 30_000) {
  if (!settled.has(state)) settled.set(state, buildsCaughtUp(state, [], ms));
  return settled.get(state);
}

/** Waits until the hub lists every thread in `listed` and no Session waits for an automatic Build. */
async function buildsCaughtUp(state, listed, ms = 30_000) {
  const auth = { bearer: readFileSync(join(state.run, 'hub.key'), 'utf8').trim() }, deadline = Date.now() + ms;
  for (;;) {
    const timeline = await topicSnapshot({ port: state.port, host: 'devbox', auth, topic: { kind: 'view', view: 'cos.timeline' } });
    const threads = await threadsOf(state), arcs = new Map(threads.map(t => [t.id, t.arc])), derived = new Set(timeline.sessions.map(s => s.threadId));
    // A Pi Team Bright Worker Session never builds automatically, so it waits for no Build.
    const workers = new Set(threads.filter(t => t.team?.role === 'worker').map(t => t.id));
    // A live idle Session not derived yet may still become eligible; it is pending too.
    const pending = [...listed.filter(id => !arcs.has(id)),
      ...threads.filter(t => t.live && t.activity === 'idle' && !derived.has(t.id) && !workers.has(t.id)).map(t => t.id),
      ...timeline.sessions.filter(s => s.waiting && !s.blocked && !arcFloor(s.messages) && !workers.has(s.threadId)).map(s => s.threadId).filter(id => !arcs.get(id) || arcs.get(id).stale)];
    if (!pending.length) return;
    if (Date.now() > deadline) assert.fail(`automatic Builds did not settle within ${ms / 1000} s: ${pending.join(', ')}`);
    await new Promise(r => setTimeout(r, 250));
  }
}

/**
 * Adds fixture Sessions under the side-effect gate (run.mjs `j.fixture`). A live idle stopped Session gets an
 * automatic Build (D16) and every new Session a derive; both call the model, so the gate opens only after the hub
 * lists `ids(result)` and those jobs finish. Sessions without a pane or control socket are not live and never build;
 * their helpers (addPreviewSession and the like) skip this gate.
 */
const addFixture = (j, add, ids) => j.fixture(async () => { const r = await add(); await buildsCaughtUp(j.state, ids(r)); return r; });

/** Pi agents in the fake Herdr: what `herdr agent list` returns on the demo Host. */
const herdrPiAgents = state => JSON.parse(readFileSync(join(state.demo, 'state.json'), 'utf8')).agents.filter(a => a.agent === 'pi');

/**
 * Row h: every live Herdr Pi agent has a Session in the threads topic with live=true, its pane as location, and a
 * matching activity (Herdr working is never shown idle). Waits until `deadline`; fails early when the matched count
 * stops growing for STALL_MS.
 */
async function liveSessionsMatch(state, deadline, stallMs = STALL_MS) {
  let best = -1, grewAt = Date.now();
  for (;;) {
    const report = paneCoverage(herdrPiAgents(state), await threadsOf(state));
    if (report.ok) return report;
    if (report.matched > best) { best = report.matched; grewAt = Date.now(); }
    const stalled = Date.now() - grewAt > stallMs, late = Date.now() > deadline;
    if (stalled || late) assert.fail(`${report.matched} of ${report.herdrPi} Herdr Pi agents matched; ${stalled ? 'count stopped growing' : 'deadline passed'}: ${JSON.stringify(report.problems)}`);
    await new Promise(r => setTimeout(r, 250));
  }
}

/**
 * Runs a seed script that starts its own disposable hub (backlog-seed.ts, agent-recovery.ts) and resolves its
 * one-line JSON verdict. The script comes from the checkout under test, so it exercises that revision's hub.
 */
function seedScript(name) {
  // run.mjs --checkout can verify a revision that predates the script; that revision lacks the checked behaviour.
  if (!existsSync(join(app, 'scripts/verify', name))) return Promise.resolve({ ok: false, reason: `scripts/verify/${name} is missing at the revision under test` });
  return new Promise(done => execFile(process.execPath, ['--no-warnings', `scripts/verify/${name}`], { cwd: app, timeout: 90_000 }, (error, stdout) => {
    try { done(JSON.parse(stdout.trim().split('\n').at(-1))); } catch { done({ ok: false, reason: error?.message ?? 'no verdict' }); }
  }));
}

/**
 * Start a third Team after the page has loaded: a leader and a Worker Session, their Herdr panes in a new tab, and
 * their memberships in the demo's Team observation (scripts/pi-demo.ts observation.json).
 */
function addLateTeam(state) {
  const t = new Date().toISOString(), dir = join(state.demo, 'agent/sessions/--work-late-team--');
  mkdirSync(dir, { recursive: true });
  const observationPath = join(state.demo, 'observation.json');
  if (!existsSync(observationPath)) throw new Error('the demo at the revision under test has no editable Team observation');
  const member = (name, role, pane) => {
    const id = `sess-late-${name}`, file = join(dir, `late-${name}.jsonl`);
    writeFileSync(file, [
      { type: 'session', version: 3, id, timestamp: t, cwd: '/work/late-team' },
      { type: 'message', id: `${id}-u`, parentId: null, timestamp: t, message: { role: 'user', content: [{ type: 'text', text: `Late Team ${name}: start after the page loads` }], timestamp: Date.parse(t) } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    return { id, file, pane, name, role };
  };
  const members = [member('lead', 'lead', 'w1:p11'), member('worker', 'teammate', 'w1:p12')];
  // Journey H rewrites the fake Herdr state concurrently (orphan-pane-red restores its own copy), so `ensure` re-adds
  // whatever is missing; callers run it while they wait.
  const ensure = () => {
    const herdrPath = join(state.demo, 'state.json'), herdr = JSON.parse(readFileSync(herdrPath, 'utf8'));
    let changed = false;
    if (!herdr.tabs.some(t => t.tab_id === 'w1:t9')) { herdr.tabs.push({ tab_id: 'w1:t9', workspace_id: 'w1', label: 'late team' }); changed = true; }
    for (const m of members) if (!herdr.agents.some(a => a.pane_id === m.pane)) { herdr.agents.push({ pane_id: m.pane, workspace_id: 'w1', tab_id: 'w1:t9', name: m.pane, terminal_title_stripped: `π late ${m.name}`, cwd: '/work/late-team', agent_status: 'idle', focused: false, agent: 'pi', agent_session: { kind: 'path', agent: 'pi', value: m.file } }); changed = true; }
    if (changed) writeFileSync(herdrPath, JSON.stringify(herdr));
    const observation = JSON.parse(readFileSync(observationPath, 'utf8'));
    if (!observation.teams.some(t => t.teamName === 'late')) {
      observation.teams.push({ teamName: 'late', issues: [], memberships: members.map(m => ({
        membershipId: `m-late-${m.name}`, teamName: 'late', memberName: m.name, coordinationRole: m.role, lifecycle: { state: 'current' },
        terminalTarget: { backend: 'herdr', kind: 'pane', targetId: m.pane }, session: { kind: 'pi-jsonl-path', locator: m.file }, issues: [],
      })) });
      writeFileSync(observationPath, JSON.stringify(observation));
    }
  };
  ensure();
  return { lead: `pi:${members[0].id}`, worker: `pi:${members[1].id}`, ensure };
}

/**
 * Run this harness's seed against the revision under test: the script loads its code from the target app (argv[2]).
 * A parent commit that lacks the checked behaviour then fails on its own code, not on a missing script.
 */
function harnessSeed(name) {
  return new Promise(done => execFile(process.execPath, ['--no-warnings', join(checkout, 'apps/ampi/scripts/verify', name), app], { cwd: app, timeout: 90_000, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
    try { done(JSON.parse(stdout.trim().split('\n').at(-1))); }
    catch { done({ ok: false, reason: `${error?.signal ?? error?.code ?? 'no verdict'}: ${stderr.trim().split('\n').slice(-4).join(' | ').slice(0, 600)}` }); }
  }));
}

/** A third reader-team Worker: a busy Session file plus its Herdr pane, both inside the disposable demo dir. */
function addWorker(state) {
  const id = 'sess-verify-worker-3', t = new Date().toISOString();
  const dir = join(state.demo, 'agent/sessions/--work-verify-team--');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'verify-worker-3.jsonl');
  writeFileSync(file, [
    { type: 'session', version: 3, id, timestamp: t, cwd: '/work/verify-team' },
    { type: 'message', id: `${id}-u`, parentId: null, timestamp: t, message: { role: 'user', content: [{ type: 'text', text: 'Synthetic Worker 3: run the reader checks' }], timestamp: Date.parse(t) } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const path = join(state.demo, 'state.json'), herdr = JSON.parse(readFileSync(path, 'utf8'));
  herdr.agents.push({ pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t1', name: 'w1:p9', terminal_title_stripped: 'π worker 3', cwd: '/work/verify-team', agent_status: 'working', focused: false, agent: 'pi', agent_session: { kind: 'path', agent: 'pi', value: file } });
  writeFileSync(path, JSON.stringify(herdr));
  return { thread: `pi:${id}`, pane: 'w1:p9' };
}

/**
 * A26b: one Session whose single tool run mixes tool calls, Pi Team Bright and intercom messages, a compaction and an
 * Auto Compact handoff and pickup, between two prose replies. Written only inside the disposable demo dir.
 */
function addMixedRunSession(state) {
  const id = 'sess-verify-mixed', t0 = Date.now() - 120_000, at = i => new Date(t0 + i * 1000).toISOString();
  const dir = join(state.demo, 'agent/sessions/--work-verify-mixed--');
  mkdirSync(dir, { recursive: true });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
  const assistant = (n, content, stopReason = 'toolUse') => ({ role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason, usage, timestamp: t0 + n * 1000, content });
  const result = (n, call) => ({ role: 'toolResult', toolCallId: call, toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: t0 + n * 1000 });
  const notice = (tag, customType) => ({ type: 'custom_message', customType, display: true, content: `A26b-${tag} synthetic message.` });
  const rows = [
    { type: 'message', id: `${id}-u`, message: { role: 'user', content: [{ type: 'text', text: 'Synthetic A26b: check the build' }], timestamp: t0 + 1000 } },
    { type: 'message', id: `${id}-a1`, message: assistant(2, [{ type: 'text', text: 'A26b-before: I check it.' }, { type: 'toolCall', id: `${id}-c1`, name: 'bash', arguments: { command: 'make' } }]) },
    { type: 'message', id: `${id}-r1`, message: result(3, `${id}-c1`) },
    { id: `${id}-dm`, ...notice('dm', 'pi-team-bright.direct-message') },
    { id: `${id}-ix`, ...notice('intercom', 'intercom_message') },
    { type: 'message', id: `${id}-a2`, message: assistant(6, [{ type: 'toolCall', id: `${id}-c2`, name: 'bash', arguments: { command: 'make test' } }]) },
    { type: 'message', id: `${id}-r2`, message: result(7, `${id}-c2`) },
    { type: 'compaction', id: `${id}-k`, summary: '## Goal\nA26b-compaction synthetic summary.', firstKeptEntryId: `${id}-u`, tokensBefore: 180_000 },
    { id: `${id}-ho`, ...notice('handoff', 'auto-compact.handoff') },
    { id: `${id}-pu`, ...notice('pickup', 'auto-compact.pickup') },
    { type: 'message', id: `${id}-a3`, message: assistant(11, [{ type: 'text', text: 'A26b-after: the build passes.' }], 'stop') },
  ];
  writeFileSync(join(dir, 'verify-mixed.jsonl'), [
    { type: 'session', version: 3, id, timestamp: at(0), cwd: '/work/verify-mixed' },
    ...rows.map((r, i) => ({ ...r, parentId: i ? rows[i - 1].id : null, timestamp: at(i + 1) })),
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  return `pi:${id}`;
}

/**
 * A19: one Session whose short assistant reply calls a tool, then bounded blocks with their own cards: tool results
 * over TOOL_CHARS (256) and over 8 KB, a custom entry and a compaction over PROSE_CHARS (1024), and last a reply over
 * the 16 KiB message bound (MESSAGE_CHARS). Written only inside the disposable demo dir.
 */
function addPreviewSession(state) {
  const id = 'sess-verify-preview', t0 = Date.now() - 120_000, at = i => new Date(t0 + i * 1000).toISOString();
  const dir = join(state.demo, 'agent/sessions/--work-verify-preview--');
  mkdirSync(dir, { recursive: true });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
  const long = `A19-long reply. ${'Synthetic prose for the preview budget. '.repeat(450)}`;
  writeFileSync(join(dir, 'verify-preview.jsonl'), [
    { type: 'session', version: 3, id, timestamp: at(0), cwd: '/work/verify-preview' },
    { type: 'message', id: `${id}-u`, parentId: null, timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'Synthetic A19: list the files' }], timestamp: t0 + 1000 } },
    { type: 'message', id: `${id}-a1`, parentId: `${id}-u`, timestamp: at(2), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'toolUse', usage, timestamp: t0 + 2000, content: [{ type: 'text', text: 'A19-short reply: I list them.' }, { type: 'toolCall', id: `${id}-c1`, name: 'bash', arguments: { command: 'ls' } }] } },
    { type: 'message', id: `${id}-r1`, parentId: `${id}-a1`, timestamp: at(3), message: { role: 'toolResult', toolCallId: `${id}-c1`, toolName: 'bash', content: [{ type: 'text', text: 'a.txt' }], isError: false, timestamp: t0 + 3000 } },
    ...[['600', 600], ['9k', 9000]].flatMap(([tag, size], k) => {
      const call = `${id}-c-${tag}`, n = 4 + k * 2;
      return [
        { type: 'message', id: `${id}-t-${tag}`, parentId: k ? `${id}-o-600` : `${id}-r1`, timestamp: at(n), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'toolUse', usage, timestamp: t0 + n * 1000, content: [{ type: 'toolCall', id: call, name: 'bash', arguments: { command: `cat A19-out-${tag}.txt` } }] } },
        { type: 'message', id: `${id}-o-${tag}`, parentId: `${id}-t-${tag}`, timestamp: at(n + 1), message: { role: 'toolResult', toolCallId: call, toolName: 'bash', content: [{ type: 'text', text: `A19-out-${tag} `.padEnd(size, 'output line. ') }], isError: false, timestamp: t0 + (n + 1) * 1000 } },
      ];
    }),
    { type: 'custom_message', id: `${id}-n`, parentId: `${id}-o-9k`, timestamp: at(8), customType: 'verify.notice', display: true, content: `A19-custom notice. ${'Synthetic notice text for the preview budget. '.repeat(30)}` },
    { type: 'compaction', id: `${id}-k`, parentId: `${id}-n`, timestamp: at(9), summary: `## Goal\nA19-compaction summary. ${'Synthetic summary text for the preview budget. '.repeat(30)}`, firstKeptEntryId: `${id}-n`, tokensBefore: 180_000 },
    { type: 'message', id: `${id}-a2`, parentId: `${id}-k`, timestamp: at(10), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'stop', usage, timestamp: t0 + 10_000, content: [{ type: 'text', text: long }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  return `pi:${id}`;
}

/**
 * A20: one Session with every disclosure row kind: thinking over PROSE_CHARS, a bash call with arguments over
 * TOOL_ARGS_CHARS and a 9 KB result, a custom notice and a compaction over PROSE_CHARS, and a reply over 16 KiB. Written
 * only inside the disposable demo dir.
 */
function addDisclosureSession(state) {
  const id = 'sess-verify-a20', t0 = Date.now() - 90_000, at = i => new Date(t0 + i * 1000).toISOString();
  const dir = join(state.demo, 'agent/sessions/--work-verify-a20--');
  mkdirSync(dir, { recursive: true });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
  const assistant = (key, parentId, i, stopReason, content) => ({ type: 'message', id: `${id}-${key}`, parentId, timestamp: at(i), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason, usage, timestamp: t0 + i * 1000, content } });
  const command = `echo A20-args ${'synthetic-argument '.repeat(130)}`;
  writeFileSync(join(dir, 'verify-a20.jsonl'), [
    { type: 'session', version: 3, id, timestamp: at(0), cwd: '/work/verify-a20' },
    { type: 'message', id: `${id}-u`, parentId: null, timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'Synthetic A20: one of each disclosure row' }], timestamp: t0 + 1000 } },
    assistant('a1', `${id}-u`, 2, 'toolUse', [
      { type: 'thinking', thinking: `A20-thinking. ${'Synthetic thinking for the preview budget. '.repeat(30)}` },
      { type: 'text', text: 'A20 runs one long command.' },
      { type: 'toolCall', id: `${id}-c`, name: 'bash', arguments: { command } },
    ]),
    { type: 'message', id: `${id}-r`, parentId: `${id}-a1`, timestamp: at(3), message: { role: 'toolResult', toolCallId: `${id}-c`, toolName: 'bash', content: [{ type: 'text', text: 'A20-out '.padEnd(9000, 'output line. ') }], isError: false, timestamp: t0 + 3000 } },
    { type: 'custom_message', id: `${id}-n`, parentId: `${id}-r`, timestamp: at(4), customType: 'verify.notice', display: true, content: `A20-custom notice. ${'Synthetic notice text for the preview budget. '.repeat(30)}` },
    { type: 'compaction', id: `${id}-k`, parentId: `${id}-n`, timestamp: at(5), summary: `## Goal\nA20-compaction summary. ${'Synthetic summary text for the preview budget. '.repeat(30)}`, firstKeptEntryId: `${id}-n`, tokensBefore: 180_000 },
    assistant('a2', `${id}-k`, 6, 'stop', [{ type: 'text', text: `A20-long reply. ${'Synthetic prose for the preview budget. '.repeat(450)}` }]),
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  return `pi:${id}`;
}

/**
 * The geometry of every visible disclosure row in the transcript: a `summary` or a `.tool-head`. The marker is the
 * ink left of the label's first text, so a native `::marker`, a glyph and an icon all measure the same way. Depth
 * counts the disclosure bodies around the row.
 */
async function disclosureRows(p) {
  const tenth = v => Math.round(v * 10) / 10;
  await p.mouse.move(0, 0);
  const count = await p.locator('.transcript :is(summary, .tool-head)').count();
  const rows = [];
  for (let i = 0; i < count; i++) {
    const head = p.locator('.transcript :is(summary, .tool-head)').nth(i);
    if (!(await head.isVisible())) continue;
    await head.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const row = await head.evaluate(el => {
      const r = el.getBoundingClientRect();
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let label;
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/[^\s▸▾▶▼►›⌄]/.test(n.textContent)) { label = n; break; }
      const range = document.createRange();
      if (label) range.selectNodeContents(label);
      const at = label ? range.getBoundingClientRect() : r;
      let depth = 0;
      for (let a = el.parentElement; a && !a.matches('.transcript'); a = a.parentElement) if (a.matches('.tool-body') || (a.matches('details') && a !== el.parentElement)) depth++;
      const kind = el.matches('.tool-head') ? 'tool' : el.parentElement?.matches('.thinking') ? 'thinking' : '';
      return { label: (el.textContent ?? '').trim().slice(0, 48), entry: el.closest('[data-entry]')?.getAttribute('data-entry') ?? '', kind, depth, left: r.left, top: r.top, height: r.height, labelX: at.left, fontSize: parseFloat(getComputedStyle(label?.parentElement ?? el).fontSize) };
    });
    const width = Math.floor(row.labelX - row.left);
    let ink;
    if (width >= 1 && row.height >= 1) {
      // Crop the region from a viewport screenshot; a clipped screenshot rejects some in-viewport rects.
      const png = (await p.screenshot()).toString('base64');
      const region = { x: Math.round(row.left), y: Math.round(row.top), width, height: Math.round(row.height) };
      ink = await p.evaluate(async ({ png, region }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = region.width; c.height = region.height;
        const g = c.getContext('2d');
        g.drawImage(img, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
        const d = g.getImageData(0, 0, c.width, c.height).data, seen = new Map();
        for (let i = 0; i < d.length; i += 4) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; seen.set(k, (seen.get(k) ?? 0) + 1); }
        const bg = [...seen].sort((a, b) => b[1] - a[1])[0][0], bgc = [bg >> 16, (bg >> 8) & 255, bg & 255];
        // Coverage relative to the marker's own contrast, summed per axis: color and subpixel position cancel out.
        const diff = new Float32Array(c.width * c.height);
        for (let i = 0; i < diff.length; i++) diff[i] = Math.max(Math.abs(d[i * 4] - bgc[0]), Math.abs(d[i * 4 + 1] - bgc[1]), Math.abs(d[i * 4 + 2] - bgc[2]));
        const peak = Math.max(...diff);
        if (peak < 48) return undefined;
        // The marker is the leftmost run of inked columns; later ink before the label (an icon, a spinner) is not.
        const cols = Array.from({ length: c.width }, (_, x) => Math.max(...Array.from({ length: c.height }, (_, y) => diff[y * c.width + x] / peak)));
        const x0 = cols.findIndex(v => v > 0.1);
        let x1 = x0;
        while (x1 + 1 < c.width && cols[x1 + 1] > 0.1) x1++;
        const rows = Array.from({ length: c.height }, (_, y) => Math.max(...Array.from({ length: x1 - x0 + 1 }, (_, k) => diff[y * c.width + x0 + k] / peak)));
        const extent = xs => xs.reduce((sum, v) => sum + (v > 0.1 ? v : 0), 0);
        return { x: x0 + 1 - cols[x0], width: extent(cols.slice(x0, x1 + 1)), height: extent(rows) };
      }, { png, region });
    }
    rows.push({ label: row.label, entry: row.entry, kind: row.kind, depth: row.depth, fontSize: row.fontSize, marker: ink && { left: tenth(Math.round(row.left) + ink.x), width: tenth(ink.width), height: tenth(ink.height) } });
  }
  return rows;
}

/** A one-exchange Session written only inside the disposable demo dir; returns its thread id. */
function addLateSession(state, id, reply) {
  const dir = join(state.demo, 'agent/sessions/--work-verify-late--');
  mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString(), ms = Date.parse(t);
  const rows = [
    { type: 'session', version: 3, id, timestamp: t, cwd: '/work/verify-late' },
    { type: 'message', id: `${id}-u`, parentId: null, timestamp: t, message: { role: 'user', content: [{ type: 'text', text: 'Synthetic late Session' }], timestamp: ms } },
    { type: 'message', id: `${id}-a`, parentId: `${id}-u`, timestamp: t, message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, content: [{ type: 'text', text: reply }], timestamp: ms } },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return `pi:${id}`;
}

/**
 * A25 and A26: one Session with a thinking block, a bash call and four extension messages in their real native shapes:
 * an intercom message, a PTB direct message, a PTB alert and an Auto Compact pickup. Each message names its sender,
 * starts with a FIRST token and ends with an END token. Written only inside the disposable demo dir.
 */
const A25 = { id: 'sess-verify-a25' };
A25.notices = [
  { key: 'im', name: 'intercom', sender: 'planner-a25', first: 'A25-intercom-first', end: 'A25-intercom-end' },
  { key: 'dm', name: 'PTB direct message', sender: 'lead-a25', first: 'A25-direct-first', end: 'A25-direct-end' },
  { key: 'al', name: 'PTB alert', sender: 'observer-a25', first: '[PiTeams clarification Alert alert_a25]', end: 'A25-alert-end' },
  { key: 'pk', name: 'Auto Compact pickup', sender: 'Auto Compact', first: 'Auto Compact pickup', end: 'A25-pickup-end' },
].map(n => ({ ...n, entry: `${A25.id}-${n.key}` }));
function addNoticeSession(state) {
  const id = A25.id, t0 = Date.now() - 70_000, at = i => new Date(t0 + i * 1000).toISOString();
  const dir = join(state.demo, 'agent/sessions/--work-verify-a25--');
  mkdirSync(dir, { recursive: true });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
  const assistant = (key, parentId, i, stopReason, content) => ({ type: 'message', id: `${id}-${key}`, parentId, timestamp: at(i), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason, usage, timestamp: t0 + i * 1000, content } });
  const prose = word => `${'Synthetic notice body line. '.repeat(6)}\n\n${`Synthetic ${word} detail. `.repeat(8)}`;
  const team = { authority: 'pi-teams-message', schemaVersion: 2, teamName: 'verify-a25', recipient: 'worker-a25', recipientMembershipId: 'm_a25', recipientSessionFile: '/work/verify-a25/worker.jsonl' };
  const batch = (msgId, from, content) => [
    'These accepted coordination records were delivered to this exact Session. Act on their full contents; presentation does not change Task state.',
    JSON.stringify({ messages: [{ id: msgId, from, sentAt: at(5), summary: content.split('\n')[0], content }] }, null, 2),
  ].join('\n');
  const [im, dm, al, pk] = A25.notices;
  const notice = (n, i, parentId, customType, content, details) => ({ type: 'custom_message', id: n.entry, parentId, timestamp: at(i), customType, display: true, content, details });
  writeFileSync(join(dir, 'verify-a25.jsonl'), [
    { type: 'session', version: 3, id, timestamp: at(0), cwd: '/work/verify-a25' },
    { type: 'message', id: `${id}-u`, parentId: null, timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'Synthetic A25: one of each extension message' }], timestamp: t0 + 1000 } },
    assistant('a1', `${id}-u`, 2, 'toolUse', [
      { type: 'thinking', thinking: `A25-thinking. ${'Synthetic thinking text. '.repeat(20)}` },
      { type: 'text', text: 'A25 runs one command.' },
      { type: 'toolCall', id: `${id}-c`, name: 'bash', arguments: { command: 'echo A25-out' } },
    ]),
    { type: 'message', id: `${id}-r`, parentId: `${id}-a1`, timestamp: at(3), message: { role: 'toolResult', toolCallId: `${id}-c`, toolName: 'bash', content: [{ type: 'text', text: 'A25-out' }], isError: false, timestamp: t0 + 3000 } },
    notice(im, 4, `${id}-r`, 'intercom_message', `**From ${im.sender}** (/work/planner-a25)\n\n_Delivered by intercom at ${at(4)}_\n\n${im.first}: please review the plan.\n${prose('intercom')}\n${im.end}`, { id: 'im_a25', from: { name: im.sender, cwd: '/work/planner-a25' } }),
    notice(dm, 5, im.entry, 'pi-team-bright.direct-message', batch('msg_a25_dm', dm.sender, `${dm.first}: the plan is accepted.\n${prose('direct')}\n${dm.end}`), { ...team, messageIds: ['msg_a25_dm'] }),
    notice(al, 6, dm.entry, 'pi-team-bright.direct-message', batch('msg_a25_al', al.sender, `${al.first}\nTask: notice-a25 @ v_0000000000000a25\n${prose('alert')}\n${al.end}`), { ...team, messageIds: ['msg_a25_al'] }),
    notice(pk, 7, al.entry, 'auto-compact.pickup', `${pk.first}: Pi compacted this Session. Continue the prior request if work remains.\n\n${prose('pickup')}\n${pk.end}`, { projection: 'pickup', runToken: 'run_a25', heldCount: 0 }),
    assistant('a2', pk.entry, 8, 'stop', [{ type: 'text', text: 'A25-final reply.' }]),
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  return `pi:${id}`;
}

/**
 * The collapsed text geometry of one transcript entry: its distinct text line tops, its height against the line
 * height of its disclosure head, every element with a computed left border, and whether each wanted text sits
 * unclipped inside the row.
 */
async function collapsedRow(p, entry, texts) {
  return p.locator(`.transcript [data-entry="${entry}"]`).first().evaluate((row, texts) => {
    const shown = n => { for (let e = n.parentElement; e && e !== row.parentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || (e.matches('details:not([open]) > :not(summary)'))) return false; } return true; };
    const nodes = [], walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent.trim() && shown(n)) nodes.push(n);
    const tops = new Set();
    for (const n of nodes) { const range = document.createRange(); range.selectNodeContents(n); for (const r of range.getClientRects()) if (r.width && r.height) tops.add(Math.round(r.top + r.height / 2)); }
    const lines = [...tops].sort((a, b) => a - b).filter((t, i, ts) => i === 0 || t - ts[i - 1] > 4).length;
    const head = row.querySelector(':is(summary, .tool-head)') ?? row, hs = getComputedStyle(head);
    const lineHeight = parseFloat(hs.lineHeight) || parseFloat(hs.fontSize) * 1.25;
    const borders = [row, ...row.querySelectorAll('*')].filter(e => parseFloat(getComputedStyle(e).borderLeftWidth) > 0 && getComputedStyle(e).borderLeftStyle !== 'none').map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const visible = {};
    for (const text of texts) {
      const n = nodes.find(n => n.textContent.includes(text));
      if (!n) { visible[text] = false; continue; }
      const range = document.createRange(), at = n.textContent.indexOf(text);
      range.setStart(n, at); range.setEnd(n, at + text.length);
      const r = range.getBoundingClientRect();
      let inside = r.width > 0;
      for (let e = n.parentElement; e && inside; e = e === row ? null : e.parentElement) {
        const cs = getComputedStyle(e), b = e.getBoundingClientRect();
        if (cs.overflowX !== 'visible' || e === row) inside = r.left >= b.left - 0.5 && r.right <= b.right + 0.5;
      }
      visible[text] = inside;
    }
    return { lines, height: Math.round(row.getBoundingClientRect().height * 10) / 10, lineHeight, borders, visible, received: /What the agent received/i.test(row.textContent) };
  }, texts);
}

/**
 * A24: one Session whose native records carry every field the browser must never see: usage and cost, a thinking
 * signature, a response ID, the provider, parent IDs and a tool duration. It holds a 2.5 KB reply, a markdown reply
 * over the 16 KiB message bound, and long tool, custom and compaction entries. Written only inside the disposable demo dir.
 */
const A24_FORBIDDEN = ['usage', 'cost', 'thinkingSignature', 'responseId', '"parentId"', 'provider', 'durationMs', 'Exact native JSON'];
/** Seeded values of native fields: they catch a leak under any key name. */
const A24_CANARIES = ['sigA24synthetic', 'msg_A24', 'anthropic-messages'];
function addProjectionSession(state) {
  const id = 'sess-verify-a24', t0 = Date.now() - 80_000, at = i => new Date(t0 + i * 1000).toISOString();
  const dir = join(state.demo, 'agent/sessions/--work-verify-a24--');
  mkdirSync(dir, { recursive: true });
  const usage = { input: 1200, output: 800, cacheRead: 0, cacheWrite: 0, totalTokens: 2000, cost: { input: 0.004, output: 0.012, total: 0.016 } };
  const assistant = (key, parentId, i, stopReason, content) => ({ type: 'message', id: `${id}-${key}`, parentId, timestamp: at(i), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', api: 'anthropic-messages', responseId: `msg_A24${key}`, stopReason, usage, timestamp: t0 + i * 1000, content } });
  const medium = `A24-medium-start. ${'Synthetic medium reply for the whole message. '.repeat(52)}A24-medium-end.`;
  const long = `A24-long-start.\n\n## A24 long heading\n\n${'Synthetic markdown prose for the message bound. '.repeat(420)}\n\n- A24 list item\n\nA24-long-end.`;
  writeFileSync(join(dir, 'verify-a24.jsonl'), [
    { type: 'session', version: 3, id, timestamp: at(0), cwd: '/work/verify-a24' },
    { type: 'message', id: `${id}-u`, parentId: null, timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'Synthetic A24: answer in full' }], timestamp: t0 + 1000 } },
    assistant('a1', `${id}-u`, 2, 'toolUse', [
      { type: 'thinking', thinking: `A24-thinking. ${'Synthetic thinking for the bound. '.repeat(40)}`, thinkingSignature: 'sigA24synthetic' },
      { type: 'text', text: medium },
      { type: 'toolCall', id: `${id}-c`, name: 'bash', arguments: { command: 'echo A24-out' } },
    ]),
    { type: 'message', id: `${id}-r`, parentId: `${id}-a1`, timestamp: at(3), message: { role: 'toolResult', toolCallId: `${id}-c`, toolName: 'bash', content: [{ type: 'text', text: 'A24-out '.padEnd(9000, 'output line. ') }], details: { durationMs: 4321 }, isError: false, timestamp: t0 + 3000 } },
    { type: 'custom_message', id: `${id}-n`, parentId: `${id}-r`, timestamp: at(4), customType: 'verify.notice', display: true, content: `A24-custom notice. ${'Synthetic notice text for the bound. '.repeat(40)}` },
    { type: 'compaction', id: `${id}-k`, parentId: `${id}-n`, timestamp: at(5), summary: `## Goal\nA24-compaction summary. ${'Synthetic summary text for the bound. '.repeat(40)}`, firstKeptEntryId: `${id}-n`, tokensBefore: 180_000 },
    assistant('a2', `${id}-k`, 6, 'stop', [{ type: 'text', text: long }]),
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  return `pi:${id}`;
}

/** Every object key in a JSON value, at any depth, and every string value. */
function jsonParts(value, keys = new Set(), strings = []) {
  if (Array.isArray(value)) for (const v of value) jsonParts(v, keys, strings);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { keys.add(k); jsonParts(v, keys, strings); }
  else if (typeof value === 'string') strings.push(value);
  return { keys, strings };
}

/**
 * An Arc stored by an older chunker for unchanged Session input: `sess-big` copied under a new Session ID, with the
 * receipt of big's last Build copied in front of it and stamped as `ampi-arc-chunker/2` wrote it: no chunker or
 * excerpt version, and a label version and chunk hashes that differ from the current build's, and every old topic starts with OLD_CHUNKER_TOPIC. The
 * receipt is written first, so the hub reads it on the Session's first Arc access. Only inside the disposable demo dir.
 */
const OLD_CHUNKER_TOPIC = 'A-chunker2-topic';
function addOldChunkerArc(state) {
  const id = 'sess-verify-chunker2', threadId = `pi:${id}`, sha = s => createHash('sha256').update(s).digest('hex');
  // The Host keeps its view state under a per-Host directory inside the demo cache.
  const cache = join(state.demo, 'cache'), big = `${sha('pi:sess-big')}.json`;
  const found = readdirSync(cache, { recursive: true }).map(String).find(f => f.endsWith(`cos.arc/${big}`));
  assert(found, `no stored Arc for sess-big under ${cache}`);
  const views = join(cache, found.slice(0, -big.length - 1));
  const receipt = JSON.parse(readFileSync(join(views, big), 'utf8'));
  // Receipts before ampi-arc-chunker/4 carry no chunk or excerpt rule version.
  delete receipt.chunkerVersion; delete receipt.excerptVersion;
  receipt.labelVersion = `chunker2-${receipt.labelVersion}`;
  for (const label of Object.values(receipt.labels)) { label.hash = `chunker2-${label.hash}`; label.topic = `${OLD_CHUNKER_TOPIC} ${label.topic}`; }
  writeFileSync(join(views, `${sha(threadId)}.json`), JSON.stringify(receipt));
  const sessions = join(state.demo, 'agent/sessions');
  const file = readdirSync(sessions, { recursive: true }).map(f => join(sessions, String(f))).find(f => f.endsWith('.jsonl') && readFileSync(f, 'utf8').slice(0, 400).includes('"id":"sess-big"'));
  assert(file, 'no sess-big Session file in the demo');
  const [header, ...rest] = readFileSync(file, 'utf8').split('\n');
  const dir = join(sessions, '--work-verify-chunker2--');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verify-chunker2.jsonl'), [JSON.stringify({ ...JSON.parse(header), id }), ...rest].join('\n'));
  return threadId;
}

/**
 * A21: two Sessions, written only inside the disposable demo dir. The running Session has a working Herdr pane and a
 * bash call without a result at its tail. The ended Session has no pane: one call followed by stop=aborted, and one
 * call followed by a later turn, neither with a result.
 */
const A21 = { run: 'sess-verify-a21-run', ended: 'sess-verify-a21-ended', pane: 'w1:p21', command: 'sleep 5; echo A21-done' };
function a21Rows(state) {
  const dir = join(state.demo, 'agent/sessions/--work-verify-a21--');
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 60_000, at = i => new Date(t0 + i * 1000).toISOString();
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
  const user = (id, parentId, i, text) => ({ type: 'message', id, parentId, timestamp: at(i), message: { role: 'user', content: [{ type: 'text', text }], timestamp: t0 + i * 1000 } });
  const assistant = (id, parentId, i, stopReason, content) => ({ type: 'message', id, parentId, timestamp: at(i), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason, usage, timestamp: t0 + i * 1000, content } });
  const call = (callId, command) => ({ type: 'toolCall', id: callId, name: 'bash', arguments: { command } });
  const file = id => join(dir, `${id}.jsonl`);
  const r = A21.run, e = A21.ended;
  writeFileSync(file(r), [
    { type: 'session', version: 3, id: r, timestamp: at(0), cwd: '/work/verify-a21' },
    user(`${r}-u`, null, 1, 'A21 running Session: run the slow check'),
    assistant(`${r}-a`, `${r}-u`, 2, 'toolUse', [{ type: 'text', text: 'I run it.' }, call(`${r}-c`, A21.command)]),
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(file(e), [
    { type: 'session', version: 3, id: e, timestamp: at(0), cwd: '/work/verify-a21' },
    user(`${e}-u0`, null, 1, 'A21 ended Session: two calls without results'),
    assistant(`${e}-a0`, `${e}-u0`, 2, 'toolUse', [call(`${e}-c0`, 'echo A21-aborted')]),
    assistant(`${e}-x`, `${e}-a0`, 3, 'aborted', []),
    user(`${e}-u1`, `${e}-x`, 4, 'Try the other one'),
    assistant(`${e}-a1`, `${e}-u1`, 5, 'toolUse', [call(`${e}-c1`, 'echo A21-later-turn')]),
    user(`${e}-u2`, `${e}-a1`, 6, 'Never mind; stop there'),
    assistant(`${e}-a2`, `${e}-u2`, 7, 'stop', [{ type: 'text', text: 'Stopped.' }]),
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  return {
    runFile: file(r),
    // H's orphan-pane-red restores its own copy of state.json, so re-add the pane whenever it is missing.
    ensurePane() {
      const path = join(state.demo, 'state.json'), herdr = JSON.parse(readFileSync(path, 'utf8'));
      if (herdr.agents.some(a => a.pane_id === A21.pane)) return;
      herdr.agents.push({ pane_id: A21.pane, workspace_id: 'w1', tab_id: 'w1:t1', name: A21.pane, terminal_title_stripped: 'π a21 run', cwd: '/work/verify-a21', agent_status: 'working', focused: false, agent: 'pi', agent_session: { kind: 'path', agent: 'pi', value: file(r) } });
      writeFileSync(path, JSON.stringify(herdr));
    },
    result: () => appendFileSync(file(r), JSON.stringify({ type: 'message', id: `${r}-o`, parentId: `${r}-a`, timestamp: new Date().toISOString(), message: { role: 'toolResult', toolCallId: `${r}-c`, toolName: 'bash', content: [{ type: 'text', text: 'A21-done' }], isError: false, timestamp: Date.now() } }) + '\n'),
  };
}

/**
 * A27: one live Session with a synthetic hc-control socket that serves typed slash commands. `/model <ref>` appends
 * a model_change entry, as Pi's setModel does, and no user entry; a submit appends a user entry, as Pi does. The
 * Session file, descriptor and pane sit in the disposable demo dir; the socket sits under /tmp for the short path a
 * Unix socket needs. Nothing reaches a real agent.
 */
// `old` serves a control from before A27: status has no commands capability and the command ops are unknown.
async function addCommandSession(state, { id = 'sess-verify-a27', pane = 'w1:p27', old = false } = {}) {
  const t = new Date().toISOString(), ms = Date.parse(t);
  const dir = join(state.demo, `agent/sessions/--work-${id}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  let last = `${id}-a`;
  writeFileSync(file, [
    { type: 'session', version: 3, id, timestamp: t, cwd: '/work/verify-a27' },
    { type: 'message', id: `${id}-u`, parentId: null, timestamp: t, message: { role: 'user', content: [{ type: 'text', text: 'Synthetic A27 Session' }], timestamp: ms } },
    { type: 'message', id: last, parentId: `${id}-u`, timestamp: t, message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, content: [{ type: 'text', text: 'A27 ready.' }], timestamp: ms } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const append = row => { appendFileSync(file, JSON.stringify({ ...row, parentId: last, timestamp: new Date().toISOString() }) + '\n'); last = row.id; };
  const models = [{ ref: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { ref: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5' }];
  let model = models[0].ref, n = 0;
  const nonce = `n-a27-${process.pid}`, socket = `/tmp/ampi-a27-${process.pid}-${Date.now() % 1e6}.sock`, requests = [];
  const reply = req => {
    if (req.op === 'status') return { ok: true, value: { sessionId: id, sessionFile: file, nonce, idle: true, compacting: false, pending: { steer: 0, followUp: 0 }, ...(old ? {} : { commands: 1 }) } };
    if (old && (req.op === 'commands' || req.op === 'command')) return { ok: false, error: { code: 'unknown_op', message: `unknown op ${req.op}` } };
    if (req.op === 'commands') return { ok: true, value: {
      commands: [
        { name: 'model', description: 'Select model', argsHint: '<provider/id>', source: 'builtin', supported: true },
        { name: 'thinking', description: 'Set the thinking level', argsHint: '<level>', source: 'builtin', supported: true },
        { name: 'reload', source: 'builtin', supported: false },
      ], models, model, thinkingLevels: ['off', 'high'], thinking: 'off' } };
    if (req.op === 'command' && req.name === 'model') {
      const match = models.find(m => m.ref === req.args);
      if (!match) return { ok: false, error: { code: 'bad_args', message: `No available model matches "${req.args ?? ''}".` } };
      const [provider, ...rest] = match.ref.split('/');
      append({ type: 'model_change', id: `${id}-mc${++n}`, provider, modelId: rest.join('/') });
      model = match.ref;
      return { ok: true, disposition: 'handled', notice: `Model: ${match.ref}`, effect: { model: match.ref } };
    }
    if (req.op === 'submit') {
      const entry = `${id}-u${++n}`;
      append({ type: 'message', id: entry, message: { role: 'user', content: [{ type: 'text', text: req.text }], timestamp: Date.now() } });
      return { ok: true, evidence: 'started', entryId: entry };
    }
    return { ok: false, error: { code: 'unknown_op', message: `unknown op ${req.op}` } };
  };
  const server = createServer(c => {
    let buf = '';
    c.setEncoding('utf8');
    // A probe that times out closes first; as in the real control, a late reply must not crash the run.
    c.on('error', () => {});
    c.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const req = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        requests.push(req);
        if (!c.destroyed && c.writable) c.write(JSON.stringify({ id: req.id, ...reply(req) }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const controlDir = join(state.demo, 'agent/hc-control');
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(controlDir, `${id}.json`), JSON.stringify({ schema: 'hc-control/1', sessionId: id, sessionFile: file, socket, pid: process.pid, nonce, startedAt: Date.now(), version: 'verify' }));
  const path = join(state.demo, 'state.json'), herdr = JSON.parse(readFileSync(path, 'utf8'));
  herdr.agents.push({ pane_id: pane, workspace_id: 'w1', tab_id: 'w1:t1', name: pane, terminal_title_stripped: `π ${id}`, cwd: '/work/verify-a27', agent_status: 'idle', focused: false, agent: 'pi', agent_session: { kind: 'path', agent: 'pi', value: file } });
  writeFileSync(path, JSON.stringify(herdr));
  const userTexts = () => readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === 'message' && r.message.role === 'user').map(r => r.message.content[0].text);
  const close = () => { server.close(); rmSync(socket, { force: true }); };
  // `upgrade` stands for the owner updating pi-hc-control and running /reload: the same socket now serves commands.
  return { thread: `pi:${id}`, file, requests, userTexts, model: () => model, close, upgrade: () => { old = false; } };
}

export const journeys = [
  {
    // Opt-in: spends real model calls, so it runs only on request (--only R1) and never in the gate.
    id: 'R1', feature: 't3a-arcs.md', title: 'Build one Arc with the real default model', optIn: true, budgetMs: 300_000,
    async run(j) {
      await j.step('real-build', 'On a separate hub with the real model, Build arc over a small fixed Session', () => new Promise((done, fail) => {
        // The script comes from this harness; the Hub it starts comes from the app under test.
        execFile(process.execPath, ['--no-warnings', join(dirname(fileURLToPath(import.meta.url)), 'real-arc-build.mjs'), app], { cwd: app, timeout: 330_000 }, (error, stdout) => {
          let verdict;
          try { verdict = JSON.parse(stdout.trim().split('\n').at(-1)); } catch { return fail(new Error(`no verdict: ${error?.message ?? 'empty output'}`)); }
          if (!verdict.ok) return fail(new Error(`${verdict.reason} · ${JSON.stringify({ state: verdict.state, model: verdict.model, labelled: verdict.labelled, chunks: verdict.chunks, cost: verdict.cost })}`));
          done(verdict);
        });
      }));
    },
  },
  {
    id: 'H', feature: 'h-live-sessions.md', title: 'Smoke: every live Herdr Pi agent is a live Session',
    async run(j) {
      const started = Date.parse(j.state.startedAt);
      // Row i: the demo Host's agent pid holds for all of H.
      const watch = agentWatch(j.state.pid), watchFrom = Date.now();
      const sampler = setInterval(() => watch.sample(), 500);
      // The two controls run their own hubs; start both now so their wait overlaps the steps before them.
      const outage = seedScript('agent-recovery.ts'), backlog = seedScript('backlog-seed.ts');
      try {
        await j.step('live-after-start', 'Compare herdr agent list (Pi agents) with the threads topic after hub start', async () => {
          const report = await liveSessionsMatch(j.state, started + LIVE_MS);
          return { ...report, msAfterStart: Date.now() - started };
        }, { expectSide: s => assert.equal(s.herdrTotal, 0, 'the smoke check sent a Herdr action'), alone: false });
        await j.step('worker-joins', 'Start a third reader-team Worker pane; its Session must join live and busy', async () => {
          const at = Date.now(), added = await addFixture(j, () => addWorker(j.state), r => [r.thread]);
          const report = await liveSessionsMatch(j.state, at + LIVE_MS);
          return { ...added, ...report, msToJoin: Date.now() - at };
        });
        await j.step('orphan-pane-red', 'Negative control: a Herdr Pi pane without a Session must turn the check red', async () => {
          const path = join(j.state.demo, 'state.json'), herdr = JSON.parse(readFileSync(path, 'utf8'));
          const orphan = { ...herdr.agents.find(a => a.pane_id === 'w1:p9'), pane_id: 'w1:p10', name: 'w1:p10', agent_session: { kind: 'path', agent: 'pi', value: join(j.state.demo, 'missing.jsonl') } };
          writeFileSync(path, JSON.stringify({ ...herdr, agents: [...herdr.agents, orphan] }));
          let error;
          try { await liveSessionsMatch(j.state, Date.now() + 4000, 2000); } catch (e) { error = e.message; }
          // Remove only the orphan from the current file: journeys share this Herdr state, and restoring the old
          // snapshot would drop panes that other journeys added meanwhile.
          const now = JSON.parse(readFileSync(path, 'utf8'));
          writeFileSync(path, JSON.stringify({ ...now, agents: now.agents.filter(a => a.pane_id !== orphan.pane_id) }));
          assert(error, 'the smoke check passed with an orphan pane');
          assert.match(error, /"pane":"w1:p10".*"problem":"missing"/);
          return { red: error.slice(0, 160) };
        });
        await j.step('outage-recovery', 'On a separate hub, stop Herdr for 2 s, then kill the Host agent; rows and panes must match again within 60 s', async () => {
          const verdict = await outage;
          assert(verdict.ok, verdict.reason);
          return verdict;
        }, { alone: false });
        await j.step('agent-stable', 'The demo Host agent kept one pid for the whole H window', async () => {
          watch.sample();
          assert(watch.history.length, 'no Host agent process found under the demo hub');
          assert.equal(watch.restarts, 0, `the Host agent restarted: ${watch.history.join(' → ')}`);
          return { windowMs: Date.now() - watchFrom, pid: watch.history[0] };
        });
        await j.step('cold-backlog', 'Start a hub on a warm cache with 240 old Sessions; new, resumed and live Sessions must get rows first', async () => {
          const verdict = await backlog;
          assert(verdict.ok, `${verdict.reason}: ${JSON.stringify(verdict.rows ?? {})}`);
          return verdict;
        }, { alone: false });
      } finally { clearInterval(sampler); }
    },
  },
  {
    id: 'T0', feature: 't0-open-ampi.md', title: 'Open AmPi and see data',
    async run(j) {
      const p = j.page;
      await j.step('enter-with-key', 'Open the hub entry URL; the hub sets its cookie and drops the key from the URL', async () => {
        await j.goto('#/v/overview');
        assert(!p.url().includes('?k='), 'key left in URL');
        return { url: p.url() };
      });
      await j.step('host-connected', 'Read the Host row on Overview', async () => {
        const row = p.locator('.ov-host[data-host="devbox"]');
        await row.locator('.dot.connected').waitFor();
        const hint = await row.locator('.hint').innerText();
        assert.match(hint, /\d+ running · \d+ Sessions in scope/);
        return { host: 'devbox', hint };
      });
      // One Host rule decides the listed set; the heading, the host hint and the sidebar must all read it. Three
      // Sessions test the edges, written only inside the disposable demo dir as recent files with old entries.
      const scopeSession = (key, ageMs, malformed) => {
        const dir = join(j.state.demo, `agent/sessions/--work-verify-${key}--`), file = join(dir, `${key}.jsonl`);
        mkdirSync(dir, { recursive: true });
        const t = new Date(Date.now() - ageMs).toISOString(), ms = Date.parse(t);
        writeFileSync(file, [
          JSON.stringify({ type: 'session', version: 3, id: `sess-verify-${key}`, timestamp: t, cwd: `/work/verify-${key}` }),
          JSON.stringify({ type: 'message', id: `${key}-u`, parentId: null, timestamp: t, message: { role: 'user', content: [{ type: 'text', text: `Synthetic ${key} Session` }], timestamp: ms } }),
          ...(malformed ? [`{"type":"message","id":"${key}-bad",`] : []),
        ].join('\n') + '\n');
        return { thread: `pi:sess-verify-${key}`, file };
      };
      const listed = thread => assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === thread), `the Host does not list ${thread}`, 20_000);
      await j.step('kept-old-session', 'Add a Session the Host keeps listed: 10-day-old entries and one unreadable line', async () => {
        const { thread } = scopeSession('kept', 10 * 86_400_000, true);
        await listed(thread);
        return { thread };
      });
      await j.step('old-but-live', 'Add a Session with 10-day-old entries that runs in a working Herdr pane now', async () => {
        const { thread, file } = scopeSession('oldlive', 10 * 86_400_000, false);
        const path = join(j.state.demo, 'state.json'), herdr = JSON.parse(readFileSync(path, 'utf8'));
        herdr.agents.push({ pane_id: 'w1:p31', workspace_id: 'w1', tab_id: 'w1:t1', name: 'w1:p31', terminal_title_stripped: 'π old live', cwd: '/work/verify-oldlive', agent_status: 'working', focused: false, agent: 'pi', agent_session: { kind: 'path', agent: 'pi', value: file } });
        writeFileSync(path, JSON.stringify(herdr));
        await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === thread && t.live), `the Host does not list ${thread} as live`, 20_000);
        return { thread };
      });
      await j.step('clock-skew', 'Add a Session with 94-hour-old entries; set the browser clock 5 h ahead of the hub', async () => {
        const { thread } = scopeSession('nearscope', 94 * 3_600_000, false);
        await listed(thread);
        await p.clock.setSystemTime(new Date(Date.now() + 5 * 3_600_000));
        const skew = await p.evaluate(() => Date.now()) - Date.now();
        assert(skew > 4 * 3_600_000, `the browser clock is not ahead: ${skew} ms`);
        return { thread, skewHours: Math.round(skew / 360_000) / 10 };
      });
      await j.step('sessions-listed', 'Read the sidebar', async () => {
        // Other journeys add Sessions at any time, so every comparison uses counts from one read of the page.
        // Every Session the top bar counts appears in the sidebar: visible rows, Workers folded under a collapsed
        // leader ([data-worker-count]), and the rows of a closed "Not in a pane (N)" group.
        await p.locator('.side-scroll .row[data-thread]').first().waitFor();
        const read = () => p.evaluate(() => {
          const side = document.querySelector('.side-scroll');
          const unplaced = side.querySelector('[data-group="unplaced"]');
          const unplacedOpen = unplaced?.querySelector('.group-row')?.getAttribute('aria-expanded') !== 'false';
          return {
            rows: side.querySelectorAll('.row[data-thread]').length,
            folded: [...side.querySelectorAll('[data-worker-count]')].reduce((n, b) => n + Number(b.textContent.replace(/[^\d]/g, '')), 0),
            unplacedClosed: unplaced && !unplacedOpen ? Number((/\((\d[\d,]*)\)/.exec(unplaced.querySelector('.group-label').textContent) ?? [0, '0'])[1].replace(/,/g, '')) : 0,
            total: Number((/([\d,]+) Sessions/.exec(document.querySelector('.topbar .crumbs').textContent) ?? [0, '-1'])[1].replace(/,/g, '')),
            inScope: Number((/([\d,]+) Sessions in scope/.exec(document.querySelector('.ov-host[data-host="devbox"] .hint')?.textContent ?? '') ?? [0, '-1'])[1].replace(/,/g, '')),
          };
        });
        const counted = s => s.rows + s.folded + s.unplacedClosed;
        let seen;
        await assertEventually(async () => { seen = await read(); return seen.rows > 0 && counted(seen) === seen.total && seen.inScope === seen.total; }, 'sidebar does not list every counted Session').catch(() => {});
        assert.equal(counted(seen), seen.total, `sidebar ${seen.rows} rows + ${seen.folded} folded Workers + ${seen.unplacedClosed} in a closed "Not in a pane" ≠ ${seen.total} Sessions`);
        assert.equal(seen.inScope, seen.total, `the host hint says ${seen.inScope} Sessions in scope; the heading says ${seen.total}`);
        // Expand all Teams: the folded Workers become rows. One click expands only when every Team is collapsed, and a
        // Team that starts later (journey S) arrives collapsed, so click until nothing is folded.
        const all = p.locator('[data-host-collapse-all]').first();
        let open;
        await assertEventually(async () => {
          open = await read();
          if (open.folded === 0 && open.rows + open.unplacedClosed === open.total) return true;
          if (open.folded) await all.click();
          return false;
        }, 'expanded sidebar does not list every counted Session').catch(() => {});
        assert.equal(open.folded, 0, `${open.folded} Workers still folded after Expand all`);
        // Journeys S and H add Sessions to the shared demo hub meanwhile; compare with the total read at the same time.
        assert.equal(open.rows + open.unplacedClosed, open.total, `expanded sidebar ${open.rows} rows + ${open.unplacedClosed} in a closed "Not in a pane" ≠ ${open.total} Sessions`);
        return { ...seen, expandedRows: open.rows };
      }, { expectSide: s => assert.equal(s.herdrTotal, 0, 'reading AmPi sent a Herdr action'), alone: false });
      await p.clock.setSystemTime(new Date());
      await j.step('timeline-data', 'Choose Timeline', async () => {
        await j.goto(timeline);
        await p.locator('.cos-band-label').first().waitFor();
        const meta = await p.locator('.cos-header .cos-meta').innerText();
        assert.match(meta, /^\d+ Sessions · \d+ streams/);
        return { meta };
      });
    },
  },
  {
    id: 'T1', feature: 't1-overview.md', title: 'Read the Overview',
    async run(j) {
      const p = j.page;
      await autoBuildsSettled(j.state);
      await j.goto('#/v/overview');
      await p.locator('[data-card="running"] .row').first().waitFor();
      await j.step('count-updates', 'Read the activity summary and top bar', async () => {
        const summary = await p.getByRole('region', { name: 'Activity since your last visit' }).innerText();
        const crumbs = await p.locator('.topbar .crumbs').innerText();
        assert.match(summary, /\d+ Sessions? updated/);
        assert.match(crumbs, /\d+ Sessions · 1 Host · \$/);
        return { summary: summary.split('\n').slice(0, 2).join(' '), crumbs };
      });
      await j.step('running-agents', 'Read the Running now card', async () => {
        const card = p.locator('[data-card="running"]');
        const count = num(await card.locator('h2 .hint').innerText());
        const ids = await card.locator('.row[data-thread]').evaluateAll(rows => rows.map(r => r.dataset.thread));
        for (const id of ['pi:sess-lead', 'pi:sess-worker-reader', 'pi:sess-ops-lead', 'pi:sess-ops-worker']) assert(ids.includes(id), `${id} not running`);
        return { count, ids };
      });
      await j.step('unhealthy-agents', 'Read the Needs you card', async () => {
        const card = p.locator('[data-card="needs"]');
        const solo = card.locator('.row[data-thread="pi:sess-solo"]');
        await solo.waitFor();
        return { count: num(await card.locator('h2 .hint').innerText()), solo: await solo.getAttribute('title') };
      });
      // Tier-2 asks come from Arc heads only (D16); the demo's automatic Builds fill them after hub start.
      // Wait outside the step: the step's model-call delta must not cover those Builds.
      await p.locator('[data-card="needs"] .ov-needs-kind[data-kind="decision"]').waitFor({ timeout: 30_000 });
      await j.step('needs-you-asks', 'Read the open Arc asks in Needs you, then choose the first Decision', async () => {
        const card = p.locator('[data-card="needs"]');
        const decision = card.locator('.ov-needs-kind[data-kind="decision"]');
        const kinds = await card.locator('.ov-needs-kind').evaluateAll(es => es.map(e => e.dataset.kind));
        const order = ['decision', 'approval', 'input', 'blocker'].filter(k => kinds.includes(k));
        assert.deepEqual(kinds, order, `kinds out of order: ${kinds}`);
        const row = decision.locator('.row[data-thread]').first();
        const reason = await row.getAttribute('title');
        assert.match(reason, /\d+ open · (asked .+ ago|ask time unknown)/);
        await row.click();
        await p.waitForURL(/#\/v\/arcs\/devbox(?:%23pi)?\//);
        await p.getByRole('region', { name: 'Evergreen context' }).getByRole('heading', { level: 2, name: /^Needs you/ }).waitFor();
        await j.goto('#/v/overview');
        await card.waitFor();
        return { kinds, reason: reason.split('\n').pop() };
      }, { expectSide: s => assert.equal(s.askCalls, 0, 'Needs you called the model') });
      await j.gap('I26', 'malformed-session-warning', 'Look for a reader-health warning about the malformed demo Session', async () => {
        const text = await p.locator('.overview').innerText();
        assert.match(text, /could not be read|malformed|unreadable/i, 'Overview shows no reader-health warning');
        return { warning: true };
      });
      await j.step('sidebar-scrolls', 'Shrink the window to 540 px and scroll the sidebar to its end', async () => {
        await p.setViewportSize({ width: 1440, height: 540 });
        const side = sideScroll(p);
        const box = await side.boundingBox();
        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        // Every sample is kept, so a failure shows whether the sidebar grew after the last wheel tick.
        const t0 = Date.now(), samples = [];
        const measure = async phase => {
          const m = await side.evaluate(e => ({ top: Math.round(e.scrollTop), max: e.scrollHeight - e.clientHeight, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight, rows: e.querySelectorAll('.row').length }));
          samples.push({ ms: Date.now() - t0, phase, ...m });
          return m;
        };
        await measure('before');
        for (let i = 0; i < 20; i++) await p.mouse.wheel(0, 400);
        await measure('wheeled');
        // Other journeys add Sessions to the shared hub, so a row can land after the last tick and raise the end.
        // Keep wheeling until the sidebar is at its end and its height held since the previous poll.
        let lastMax = -1;
        await assertEventually(async () => {
          const m = await measure('wait'), held = m.max === lastMax;
          lastMax = m.max;
          if (m.max > 0 && m.top >= m.max - 1 && held) return true;
          await p.mouse.wheel(0, 400);
          return false;
        }, 'sidebar did not reach its end', 10_000).catch(() => {});
        const m = await measure('final');
        const fail = async message => Object.assign(new Error(message), { detail: { samples, rows: await sidebarRows(side) } });
        if (!(m.max > 0)) throw await fail('sidebar does not overflow at 540 px');
        if (!(m.top >= m.max - 1)) throw await fail(`sidebar stopped at ${m.top} of ${m.max}`);
        await p.setViewportSize({ width: 1440, height: 960 });
        return { ...m, samples };
      });
      await j.step('page-keeps-place', 'Add 20 quiet Sessions, then page the Quiet card with Next and Previous', async () => {
        await addFixture(j, () => addQuietSessions(j.state), () => Array.from({ length: 20 }, (_, i) => `pi:sess-verify-quiet-${i}`));
        // The pager label counts all quiet Sessions; read it only after the hub lists all 20 new ones.
        await assertEventually(async () => (await threadsOf(j.state)).filter(t => t.id.startsWith('pi:sess-verify-quiet-')).length === 20, 'the hub does not list all 20 quiet Sessions', 20_000);
        const card = p.locator('[data-card="quiet"]');
        await card.locator('.list-page').waitFor({ timeout: 20_000 });
        const pager = card.locator('.list-page');
        await pager.scrollIntoViewIfNeeded();
        // Other journeys add Sessions while this one pages, so a page is its range ("1–12", not the total), and the card
        // may move by as much as the content above it grows. Paging itself must move neither the card nor the pager.
        const place = () => card.evaluate(c => {
          const scroller = document.querySelector('.main .scroll'), pg = c.querySelector('.list-page'), cy = c.getBoundingClientRect().top;
          const label = pg.querySelector('.hint').textContent;
          return { y: Math.round(pg.getBoundingClientRect().top), cardY: Math.round(cy), offset: Math.round(cy - scroller.getBoundingClientRect().top + scroller.scrollTop), label, range: label.split(' of ')[0].trim() };
        });
        const before = await place();
        await pager.getByRole('button', { name: 'Next', exact: true }).click();
        await assertEventually(async () => (await place()).range !== before.range, 'Next did not change the page');
        await j.settle();
        const next = await place();
        await pager.getByRole('button', { name: 'Previous', exact: true }).click();
        await assertEventually(async () => (await place()).range === before.range, 'Previous did not return');
        await j.settle();
        const back = await place();
        assert.notEqual(next.range, before.range, 'Next did not change the page');
        for (const s of [next, back]) {
          const inCard = (s.y - s.cardY) - (before.y - before.cardY), moved = s.cardY - before.cardY, grown = s.offset - before.offset;
          assert(Math.abs(inCard) <= 1, `the pager moved ${inCard} px inside its card (${s.range})`);
          assert(Math.abs(moved) <= 1 || Math.abs(moved - grown) <= 1, `the card moved ${moved} px on screen while the content above it grew ${grown} px (${s.range})`);
        }
        return { before, next, back };
      });
    },
  },
  {
    id: 'T2', feature: 't2-timeline.md', title: 'Read the Timeline',
    async run(j) {
      const p = j.page;
      await j.goto(timeline);
      await p.locator('.cos-band-label').first().waitFor();
      await j.step('streams-only', 'Read the stream plots', async () => {
        const plots = p.locator('svg[aria-label$=", spend over time"]');
        const count = await plots.count();
        assert(count >= 3, `plots ${count}`);
        const marks = await plots.locator('circle, .cos-error, .cos-stop').count();
        assert.equal(marks, 0, 'plots carry stop/continue/error marks');
        return { plots: count, marks };
      });
      await j.step('team-totals', 'Read each Team lane total for the period', async () => {
        const totals = await p.locator('.cos-total[title^="Team total in range"]').evaluateAll(es => es.map(e => e.getAttribute('title')));
        assert(totals.length >= 2, `Team totals ${totals.length}`);
        return { totals };
      });
      await j.step('unit-dollars', 'Choose Dollars', async () => {
        await p.getByRole('navigation', { name: 'Timeline controls' }).getByRole('link', { name: 'Dollars', exact: true }).click();
        await p.waitForURL(/unit=dollars/);
        await p.locator('.cos-caption', { hasText: 'reported dollars' }).waitFor();
        const totals = await p.locator('.cos-total[title^="Team total in range"]').evaluateAll(es => es.map(e => e.getAttribute('title')));
        assert(totals.every(t => t.includes('$')), 'Team totals are not in dollars');
        return { url: p.url().split('#')[1], totals };
      });
      await j.step('unit-tokens', 'Choose Tokens', async () => {
        await p.getByRole('navigation', { name: 'Timeline controls' }).getByRole('link', { name: 'Tokens', exact: true }).click();
        await p.waitForURL(/unit=tokens/);
        await p.locator('.cos-caption', { hasText: 'tokens (input + output + cache)' }).waitFor();
        return { url: p.url().split('#')[1] };
      });
      await j.step('brush-period', 'Move the brush start handle right by 24 hours with the keyboard', async () => {
        const start = p.getByRole('slider', { name: 'Range start' });
        const before = Number(await start.getAttribute('aria-valuenow'));
        await start.focus();
        for (let i = 0; i < 24; i++) await p.keyboard.press('Shift+ArrowRight');
        await p.waitForURL(/from=\d+/);
        const after = Number(await start.getAttribute('aria-valuenow'));
        const hours = Math.round((after - before) / 3600_000);
        assert(hours >= 20, `start moved ${hours} h`);
        return { movedHours: hours, window: await p.getByRole('button', { name: /^Time window:/ }).innerText() };
      });
      await j.step('hover-bucket', 'Hover the first stream', async () => {
        const link = p.locator('svg a[aria-label$=" at nearest entry"]').first();
        const box = await link.boundingBox();
        await p.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
        const inspector = p.locator('.cos-inspector');
        await assertEventually(async () => /\/ 15 min/.test(await inspector.innerText()), 'inspector shows no bucket');
        return { inspector: await inspector.innerText() };
      });
    },
  },
  {
    id: 'T2teams', feature: 't2-timeline.md', title: 'Toggle Teams on the Timeline without losing the place',
    run: j => timelineTeams(j, addFixture),
  },
  {
    id: 'T3', feature: 't3-open-session.md', title: 'Open an important Session',
    async run(j) {
      const p = j.page;
      await j.step('from-overview', 'Choose the lead row in Running now', async () => {
        await j.goto('#/v/overview');
        await p.locator('[data-card="running"] .row[data-thread="pi:sess-lead"]').click();
        await p.waitForURL(/\/t\/pi%3Asess-lead/);
        await p.locator('.composer').waitFor();
        return { url: p.url().split('#')[1] };
      });
      await j.step('from-sidebar', 'Choose the big Session in the sidebar', async () => {
        const title = p.locator('.side-scroll .row[data-thread="pi:sess-big"] a.title');
        const name = await title.innerText();
        // Sample every painted frame after the click: the view may lag the URL by a frame, but the title must never
        // name the previous Session while the transcript already shows the new one.
        await p.evaluate(() => { const t0 = performance.now(); window.__t3Frames = []; const tick = () => {
          window.__t3Frames.push({ ms: Math.round(performance.now() - t0), title: document.querySelector('[aria-label="Thread title"]')?.value ?? null, entry: document.querySelector('.transcript [data-entry]')?.getAttribute('data-entry') ?? null });
          if (performance.now() - t0 < 2000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
        const before = await p.evaluate(() => ({ title: document.querySelector('[aria-label="Thread title"]')?.value ?? null, entry: document.querySelector('.transcript [data-entry]')?.getAttribute('data-entry') ?? null }));
        await title.click();
        await p.waitForURL(/\/t\/pi%3Asess-big/);
        const box = p.getByRole('textbox', { name: 'Thread title' });
        let shown;
        await assertEventually(async () => (shown = await box.inputValue()).includes(name.slice(0, 20)), `title ${shown} does not match ${name}`, 8000).catch(() => {});
        assert(shown.includes(name.slice(0, 20)), `title ${shown} does not match ${name}`);
        await assertEventually(() => p.evaluate(() => window.__t3Frames.at(-1)?.ms >= 1900), 'the frame sampler did not finish', 8000);
        const frames = await p.evaluate(() => window.__t3Frames);
        const mixed = frames.filter(f => f.title === before.title && f.entry && f.entry !== before.entry);
        assert.equal(mixed.length, 0, `${mixed.length} frames show the previous title "${before.title}" over the new transcript (first at ${mixed[0]?.ms} ms)`);
        return { name, shown, frames: frames.length, staleViewFrames: frames.filter(f => f.title === before.title).length };
      });
      await j.step('metadata-hover', 'Hover the Session title', async () => {
        await p.locator('.session-title-line').first().hover();
        const card = p.getByRole('region', { name: 'Session metadata' });
        await card.waitFor();
        const text = await card.innerText();
        for (const key of ['Started', 'Updated', 'Model', 'Cost']) assert(text.includes(key), `${key} missing`);
        return { fields: text.split('\n').filter(Boolean).length };
      });
      await j.step('from-timeline', 'Click a stream in Timeline to open its nearest entry', async () => {
        await j.goto(timeline + '?teams=separate');
        const link = p.locator('svg a[aria-label="Open worker-gui at nearest entry"], svg a[aria-label$=" at nearest entry"]').first();
        const label = await link.getAttribute('aria-label');
        const box = await link.boundingBox();
        await p.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
        await p.waitForURL(/\/t\//);
        await p.locator('.composer').waitFor();
        return { label, url: p.url().split('#')[1] };
      });
    },
  },
  {
    id: 'T0t', feature: 't0-open-ampi.md', title: 'Choose System, Light or Dark in the sidebar (A22)',
    async run(j) {
      const p = j.page;
      const theme = p.getByRole('group', { name: 'Theme', exact: true });
      const read = () => p.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, dataTheme: document.documentElement.dataset.theme ?? null }));
      const pressed = async () => (await theme.getByRole('button', { pressed: true }).innerText()).trim();
      const choose = async label => { await theme.getByRole('button', { name: label, exact: true }).click(); await j.settle(); };
      const reload = async () => { await p.reload({ waitUntil: 'domcontentloaded' }); const early = await read(); await p.locator('.app').waitFor({ timeout: 30_000 }); return early; };
      let light, dark;
      await j.step('find-toggle', 'Open Overview on a light OS; find the System · Light · Dark control in the sidebar footer', async () => {
        await p.emulateMedia({ colorScheme: 'light' });
        await j.goto('#/v/overview');
        await p.locator('.side-footer').getByRole('group', { name: 'Theme', exact: true }).waitFor({ timeout: 4000 });
        assert.equal(await pressed(), 'System');
        light = (await read()).background;
        return { pressed: 'System', light };
      });
      await j.step('dark', 'Choose Dark on a light OS', async () => {
        await choose('Dark');
        const v = await read(); dark = v.background;
        assert.notEqual(dark, light, 'the body background did not change');
        assert.equal(v.dataTheme, 'dark');
        return v;
      });
      await j.step('dark-survives-reload', 'Reload; the page must open dark before React runs', async () => {
        const early = await reload();
        assert.deepEqual(early, { background: dark, dataTheme: 'dark' }, 'the choice was not applied before the app script');
        assert.equal(await pressed(), 'Dark');
        return early;
      });
      await j.step('light', 'Switch the OS to dark, then choose Light', async () => {
        await p.emulateMedia({ colorScheme: 'dark' });
        await choose('Light');
        const v = await read();
        assert.deepEqual(v, { background: light, dataTheme: 'light' }, 'Light did not override a dark OS');
        return v;
      });
      await j.step('light-survives-reload', 'Reload on the dark OS', async () => {
        const early = await reload();
        assert.deepEqual(early, { background: light, dataTheme: 'light' });
        assert.equal(await pressed(), 'Light');
        return early;
      });
      await j.step('system', 'Choose System; the page follows the OS and its later changes', async () => {
        await choose('System');
        const onDark = await read();
        assert.deepEqual(onDark, { background: dark, dataTheme: null }, 'System did not follow the dark OS');
        await p.emulateMedia({ colorScheme: 'light' }); await j.settle();
        const onLight = await read();
        assert.deepEqual(onLight, { background: light, dataTheme: null }, 'System did not follow the OS change');
        const early = await reload();
        assert.equal(early.dataTheme, null, 'System left a stored choice');
        assert.equal(await pressed(), 'System');
        return { onDark: onDark.background, onLight: onLight.background };
      });
    },
  },
  {
    id: 'T3p', feature: 't3-open-session.md', title: 'Read which entries offer their full text (A19, A24)',
    async run(j) {
      const p = j.page;
      await j.step('open', 'Add the A19 Session, then open it', async () => {
        const thread = addPreviewSession(j.state);
        await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === thread), `the hub does not list ${thread}`, 20_000);
        await j.goto(`#/h/devbox/t/${encodeURIComponent(thread)}`);
        await p.getByText('A19-long reply', { exact: false }).first().waitFor({ timeout: 20_000 });
        return { thread };
      });
      // A transcript-level "Preview shortened" disclosure sits outside every card. A card's own disclosure sits inside it.
      const CARDS = '.msg, .tool, .compaction-body';
      const transcriptLevel = () => p.locator('details.entry-body').evaluateAll((ds, cards) => ds.filter(d => !d.parentElement.closest(cards))
        .map(d => ({ label: d.querySelector('summary')?.textContent ?? '', after: (d.parentElement.previousElementSibling?.textContent ?? '').slice(0, 60) })), CARDS);
      // Each "Show full message" control, with the start of the nearest enclosing text that is more than the control.
      const showFull = () => p.locator('.transcript button').evaluateAll(bs => bs.filter(b => /Show full message/.test(b.textContent)).map(b => {
        let a = b.parentElement;
        while (a && (a.textContent ?? '').length < b.textContent.length + 20) a = a.parentElement;
        return (a?.textContent ?? '').slice(0, 60);
      }));
      await j.step('short-with-tool', 'Read the short reply that calls a tool', async () => {
        const controls = await showFull();
        const wrong = controls.filter(t => t.includes('A19-short'));
        assert.equal(wrong.length, 0, `a short reply with a tool call offers "Show full message": ${JSON.stringify(controls)}`);
        return { controls: controls.length };
      });
      await j.step('long-prose', 'Read the reply over the 16 KiB message bound', async () => {
        const controls = await showFull();
        assert(controls.some(t => t.includes('A19-long')), `the long reply offers no "Show full message": ${JSON.stringify(controls)}`);
        return { controls: controls.length };
      });
      await j.step('no-transcript-flags', 'Read the transcript around the long reply, the long tool results, the custom entry and the compaction', async () => {
        const top = await transcriptLevel();
        assert.equal(top.length, 0, `${top.length} transcript-level "Preview shortened" rows: ${JSON.stringify(top)}`);
        return { transcriptLevel: top.length };
      });
      await j.step('card-source-links', 'Open each tool card; read the custom entry and the compaction bodies', async () => {
        for (const tag of ['600', '9k']) {
          const head = p.locator('.tool .tool-head', { hasText: `cat A19-out-${tag}.txt` }).first();
          if (await head.getAttribute('aria-expanded') !== 'true') await head.click();
        }
        const links = await p.evaluate(() => {
          const own = el => el ? [...el.querySelectorAll('details.entry-body')].map(d => d.querySelector('summary')?.textContent ?? '') : ['card not found'];
          const card = (selector, text) => [...document.querySelectorAll(selector)].find(e => e.textContent.includes(text));
          const tool = tag => [...document.querySelectorAll('.tool')].find(e => e.querySelector('.tool-head')?.textContent.includes(`cat A19-out-${tag}.txt`));
          return {
            'tool result > 256': own(tool('600')),
            'tool result > 8 KB': own(tool('9k')),
            'custom entry': own(card('.msg.notice', 'A19-custom')),
            compaction: own(card('details.compaction-body', 'A19-compaction')),
          };
        });
        const missing = Object.entries(links).filter(([, labels]) => !labels.some(l => /Read source entry/.test(l))).map(([card]) => card);
        assert.equal(missing.length, 0, `no source link inside the card for: ${missing.join(', ')} (${JSON.stringify(links)})`);
        return links;
      });
    },
  },
  {
    id: 'T3d', feature: 't3-open-session.md', title: 'Read one disclosure-row geometry (A20)',
    async run(j) {
      const p = j.page;
      await j.step('open', 'Add the A20 Session, open it, open the thinking and expand the tool call', async () => {
        const thread = addDisclosureSession(j.state);
        await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === thread), `the hub does not list ${thread}`, 20_000);
        await j.goto(`#/h/devbox/t/${encodeURIComponent(thread)}`);
        await p.getByText('A20-long reply', { exact: false }).first().waitFor({ timeout: 20_000 });
        const thinking = p.locator('.transcript details.thinking').first();
        if (!(await thinking.evaluate(d => d.open))) await thinking.locator('summary').first().click();
        const head = p.locator('.transcript .tool-head', { hasText: 'A20-args' }).first();
        if (await head.getAttribute('aria-expanded') !== 'true') await head.click();
        await p.locator('.transcript .tool-body').first().waitFor({ timeout: 3000 });
        return { thread };
      });
      // A scroll event arrives a frame after the scroll. A render in between must not pull a reader who left the bottom back
      // to it. The Find button renders the Session view in the same task as the scroll, so this check is deterministic.
      await j.step('scroll-survives-render', 'Scroll from the bottom to the top; a render before the scroll event keeps the top', async () => {
        const scroller = p.locator('[data-region="transcript"]');
        const frames = () => p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await frames();
        const find = p.locator('button', { hasText: /^Find$/ }).first();
        const after = await scroller.evaluate(async (el, button) => {
          el.scrollTop = 0;
          button.click();
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          return { top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight };
        }, await find.elementHandle());
        await find.click();
        await frames();
        assert(after.top < 50, `the render pulled the reader back toward the bottom: scrollTop ${after.top} of ${after.bottom}`);
        return after;
      });
      await j.step('one-geometry', 'Measure the marker and label of every disclosure row', async () => {
        const rows = await disclosureRows(p);
        await p.locator('.transcript').evaluate(el => el.querySelector(':is(summary, .tool-head)')?.scrollIntoView({ block: 'start' }));
        await p.screenshot({ path: join(j.state.proof, 'T3d', 'disclosure-rows.png'), fullPage: false });
        const spread = xs => Math.max(...xs) - Math.min(...xs);
        const table = rows.map(r => `${r.depth} ${r.marker ? `x=${r.marker.left} ${r.marker.width}x${r.marker.height}` : 'no marker'} ${r.fontSize}px "${r.label}"`).join(' | ');
        assert(rows.length >= 5, `too few disclosure rows: ${table}`);
        const unmarked = rows.filter(r => !r.marker);
        assert.equal(unmarked.length, 0, `rows without a marker: ${table}`);
        const problems = [];
        for (const depth of new Set(rows.map(r => r.depth))) {
          const xs = rows.filter(r => r.depth === depth).map(r => r.marker.left);
          if (spread(xs) > 0.5) problems.push(`depth ${depth} marker left x spreads ${spread(xs).toFixed(1)} px`);
        }
        // An open marker points down, so compare its long and short sides, not width and height.
        const sides = { long: r => Math.max(r.marker.width, r.marker.height), short: r => Math.min(r.marker.width, r.marker.height) };
        for (const [side, of] of Object.entries(sides)) if (spread(rows.map(of)) > 0.5) problems.push(`marker ${side} side spreads ${spread(rows.map(of)).toFixed(1)} px`);
        if (spread(rows.map(r => r.fontSize)) > 0) problems.push(`label font-size spreads ${spread(rows.map(r => r.fontSize))} px`);
        assert.equal(problems.length, 0, `${problems.join('; ')} · rows (depth, marker, label font): ${table}`);
        return { rows };
      });
      // The reading place under streamed output, the owner's case. These run after one-geometry, which needs the rows open.
      const file = join(j.state.demo, 'agent/sessions/--work-verify-a20--/verify-a20.jsonl');
      let last = 'sess-verify-a20-a2', n = 0;
      const reply = text => {
        const id = `sess-verify-a20-s${++n}`;
        appendFileSync(file, JSON.stringify({ type: 'message', id, parentId: last, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, timestamp: Date.now(), content: [{ type: 'text', text: `${text}. ${'Synthetic streamed prose. '.repeat(20)}` }] } }) + '\n');
        last = id;
      };
      const scroller = p.locator('[data-region="transcript"]');
      const shown = text => p.locator('.transcript').getByText(text, { exact: false }).first().waitFor({ timeout: 20_000 });
      // Away readers freeze their painted window. Source admission does not require new rows to paint.
      const admitted = text => assertEventually(async () => {
        const source = await topicSnapshot({ port: j.state.port, host: 'devbox', auth: { bearer: readFileSync(join(j.state.run, 'hub.key'), 'utf8').trim() }, topic: { kind: 'thread', threadId: 'pi:sess-verify-a20' } });
        return source.entries.some(entry => JSON.stringify(entry).includes(text));
      }, `the reader source did not admit ${text}`, 20_000);
      const where = () => scroller.evaluate(el => ({ top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) }));
      await j.step('follow-through-collapse', 'At the bottom, collapse the tool call above, then a reply streams in; the view follows it', async () => {
        await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await j.settle();
        // Scroll anchoring off is what keeps a collapse above from reading as a scroll-up (keep-place leftBottom).
        assert.equal(await scroller.evaluate(el => getComputedStyle(el).overflowAnchor), 'none');
        // A DOM click does not scroll the row into view, so the reader stays at the bottom.
        await p.locator('.transcript .tool-head', { hasText: 'A20-args' }).first().evaluate(head => head.click());
        reply('A20-follow');
        await shown('A20-follow');
        await j.settle();
        const at = await where();
        assert(at.gap <= 2, `the view stopped following: ${at.gap} px above the bottom`);
        return at;
      });
      await j.step('append-while-up', 'Scroll up one screen, then three replies stream in; the reading place stays', async () => {
        await scroller.evaluate(el => { el.scrollTop = el.scrollHeight - 2 * el.clientHeight; });
        await j.settle();
        const before = await where();
        for (const k of [1, 2, 3]) reply(`A20-stream-${k}`);
        await admitted('A20-stream-3');
        await j.settle();
        const after = await where();
        assert(Math.abs(after.top - before.top) <= 2, `the reader moved ${before.top} → ${after.top} (${after.gap} px above the bottom)`);
        return { before, after };
      });
      await j.step('back-keeps-place', 'From that place open the Overview, go Back, then a reply streams in; the restored place stays', async () => {
        const mark = () => scroller.evaluate(el => {
          const box = el.getBoundingClientRect();
          const first = [...el.querySelectorAll('[data-entry]')].find(e => e.getBoundingClientRect().bottom > box.top);
          return first && { entry: first.dataset.entry, y: Math.round(first.getBoundingClientRect().top - box.top) };
        });
        const before = await mark();
        await j.goto('#/v/overview');
        await p.locator('.overview').waitFor();
        await p.goBack();
        await scroller.waitFor();
        await admitted('A20-stream-3');
        const at = () => scroller.evaluate((el, id) => { const e = el.querySelector(`[data-entry="${CSS.escape(id)}"]`); return e && Math.round(e.getBoundingClientRect().top - el.getBoundingClientRect().top); }, before.entry);
        await assertEventually(async () => { const y = await at(); return y !== null && Math.abs(y - before.y) <= 4; }, `Back did not restore entry ${before.entry} at ${before.y}`);
        reply('A20-after-back');
        await admitted('A20-after-back');
        await j.settle();
        const after = await at();
        assert(after !== null && Math.abs(after - before.y) <= 4, `entry ${before.entry} moved ${before.y} → ${after} after a reply`);
        return { entry: before.entry, before: before.y, after };
      });
    },
  },
  {
    id: 'T3n', feature: 't3-open-session.md', title: 'Read extension messages as one-line disclosure rows (A25, A26)',
    async run(j) {
      const p = j.page;
      const label = n => `${n.name} ${n.entry.slice(A25.id.length + 1)}`;
      await j.step('open', 'Add the A25 Session, open it, and leave every row collapsed', async () => {
        const thread = addNoticeSession(j.state);
        await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === thread), `the hub does not list ${thread}`, 20_000);
        await j.goto(`#/h/devbox/t/${encodeURIComponent(thread)}`);
        await p.getByText('A25-final reply', { exact: false }).first().waitFor({ timeout: 20_000 });
        const thinking = p.locator('.transcript details.thinking').first();
        if (await thinking.evaluate(d => d.open)) await thinking.locator('summary').first().click();
        const missing = [];
        for (const n of A25.notices) if (!(await p.locator(`.transcript [data-entry="${n.entry}"]`).count())) missing.push(label(n));
        assert.deepEqual(missing, [], `the transcript has no row for: ${missing.join(', ')}`);
        return { thread };
      });
      await j.step('collapsed', 'Read each collapsed extension row: one line, sender and first line visible, no left border', async () => {
        await p.locator(`.transcript [data-entry="${A25.notices[0].entry}"]`).scrollIntoViewIfNeeded();
        await p.screenshot({ path: join(j.state.proof, 'T3n', 'collapsed-rows.png'), fullPage: false });
        const problems = [], rows = {};
        for (const n of A25.notices) {
          const r = rows[n.key] = await collapsedRow(p, n.entry, [n.sender, n.first]);
          const name = label(n);
          if (r.lines !== 1) problems.push(`${name} has ${r.lines} text lines`);
          if (r.height > r.lineHeight * 1.8) problems.push(`${name} is ${r.height} px high for a ${r.lineHeight} px line`);
          for (const text of [n.sender, n.first]) if (!r.visible[text]) problems.push(`${name} hides "${text}"`);
          if (r.borders.length) problems.push(`${name} has a left border on ${r.borders.join(', ')}`);
          if (r.received) problems.push(`${name} has a "What the agent received" element`);
        }
        assert.equal(problems.length, 0, problems.join('; '));
        return { rows };
      });
      await j.step('markers', 'Measure each extension row marker against the thinking row and the tool row', async () => {
        const rows = await disclosureRows(p);
        const fmt = r => `${r.kind || r.entry.slice(A25.id.length + 1) || '?'} ${r.marker ? `x=${r.marker.left} ${r.marker.width}x${r.marker.height}` : 'no marker'}`;
        const table = rows.map(fmt).join(' | ');
        const refs = ['thinking', 'tool'].map(kind => rows.find(r => r.kind === kind && r.depth === 0 && r.marker));
        assert(refs.every(Boolean), `no measured thinking row or tool row: ${table}`);
        const problems = [];
        const long = r => Math.max(r.marker.width, r.marker.height), short = r => Math.min(r.marker.width, r.marker.height);
        for (const n of A25.notices) {
          const own = rows.filter(r => r.entry === n.entry && r.depth === 0);
          if (own.length !== 1) { problems.push(`${label(n)} has ${own.length} top-level disclosure rows`); continue; }
          const [r] = own;
          if (!r.marker) { problems.push(`${label(n)} has no marker`); continue; }
          for (const ref of refs) {
            if (Math.abs(r.marker.left - ref.marker.left) > 0.5) problems.push(`${label(n)} marker x ${r.marker.left} vs ${ref.kind} ${ref.marker.left}`);
            if (Math.abs(long(r) - long(ref)) > 0.5 || Math.abs(short(r) - short(ref)) > 0.5) problems.push(`${label(n)} marker ${r.marker.width}x${r.marker.height} vs ${ref.kind} ${ref.marker.width}x${ref.marker.height}`);
          }
        }
        assert.equal(problems.length, 0, `${problems.join('; ')} · rows: ${table}`);
        return { rows };
      });
      await j.step('expand', 'Open each extension row and read its full text', async () => {
        const missing = [];
        for (const n of A25.notices) {
          const row = p.locator(`.transcript [data-entry="${n.entry}"]`).first();
          await row.locator(':is(summary, .tool-head)').first().click();
          const ok = await assertEventually(async () => (await row.innerText()).includes(n.end), '', 3000).then(() => true, () => false);
          if (!ok) missing.push(label(n));
        }
        await p.screenshot({ path: join(j.state.proof, 'T3n', 'expanded-rows.png'), fullPage: false });
        assert.deepEqual(missing, [], `the open row does not show the full text: ${missing.join(', ')}`);
        return {};
      });
    },
  },
  {
    id: 'T3r', feature: 't3-open-session.md', title: 'Open a direct Session route before the Host lists the Session',
    async run(j) {
      const p = j.page;
      const empty = p.locator('.transcript .empty');
      await j.step('missing', 'Open a direct route to a Session id the Host does not have; read the not-found text', async () => {
        await j.goto('#/v/overview');
        await assertEventually(async () => (await threadsOf(j.state)).length > 0, 'the Host lists no Sessions', 20_000);
        await j.goto(`#/h/devbox/t/${encodeURIComponent('pi:sess-verify-never')}`);
        await assertEventually(async () => (await empty.innerText().catch(() => '')).includes('Unknown Session on this Host'),
          `the transcript does not say the Session is unknown: "${await empty.innerText().catch(() => '')}"`, 10_000);
        return { text: await empty.innerText() };
      });
      await j.step('late', 'Open a direct route before its Session exists, then create the Session; read the transcript within 5 s with no reload', async () => {
        const id = 'sess-verify-late', reply = 'T3r-late-reply';
        await j.goto(`#/h/devbox/t/${encodeURIComponent(`pi:${id}`)}`);
        await assertEventually(async () => (await empty.innerText().catch(() => '')).includes('Unknown Session on this Host'), 'the route to the absent Session shows no not-found text', 10_000);
        await p.evaluate(() => { window.__t3rLoad = true; });
        addLateSession(j.state, id, reply);
        const created = Date.now();
        // In the transcript: the sidebar row of a newly listed Session can carry the same text.
        await p.locator('.transcript').getByText(reply, { exact: false }).first().waitFor({ timeout: 5000 })
          .catch(async () => assert.fail(`no transcript 5 s after the Session was created; the page shows "${await empty.innerText().catch(() => '')}"`));
        const ms = Date.now() - created;
        assert.equal(await p.evaluate(() => window.__t3rLoad === true), true, 'the page reloaded');
        return { ms };
      });
      await j.step('still-missing', 'Return to the never-created Session; it still reads not found', async () => {
        await j.goto(`#/h/devbox/t/${encodeURIComponent('pi:sess-verify-never')}`);
        await assertEventually(async () => (await empty.innerText().catch(() => '')).includes('Unknown Session on this Host'), 'the never-created Session no longer reads not found', 10_000);
        return { text: await empty.innerText() };
      });
    },
  },
  {
    id: 'T3c', feature: 't3-open-session.md', title: 'Run Pi slash commands from the composer as typed commands (A27)',
    async run(j) {
      const p = j.page, box = p.getByRole('textbox', { name: 'Message the agent' });
      const s = await addFixture(j, () => addCommandSession(j.state), r => [r.thread]);
      let old;
      try {
        await j.step('open', 'Open the live A27 Session; its composer shows the control and the model card shows Sonnet', async () => {
          await j.goto(`#/h/devbox/t/${encodeURIComponent(s.thread)}`);
          await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === s.thread && t.control === true), 'the Host never lists the A27 Session with a live control', 20_000);
          await assertEventually(async () => /claude-sonnet-5-5/.test(await p.locator('.model-hud-trigger').innerText().catch(() => '')), 'the model card does not show Sonnet', 10_000);
          return { model: await p.locator('.model-hud-trigger').innerText() };
        });
        await j.step('model', 'Type /model anthropic/claude-opus-5-5 and press Enter; the model card shows Opus, the transcript has no /model message, and Pi got a command op and no submit', async () => {
          await box.fill('/model anthropic/claude-opus-5-5');
          await box.press('Enter');
          await assertEventually(async () => s.model() === 'anthropic/claude-opus-5-5' || s.userTexts().some(t => t.startsWith('/model')), 'the composer sent nothing to Pi', 10_000);
          assert.deepEqual(s.userTexts().filter(t => t.startsWith('/model')), [], 'the /model command became a user message in the Session file');
          assert.equal(s.requests.filter(r => r.op === 'submit').length, 0, 'the /model command reached Pi as text');
          await assertEventually(async () => /claude-opus-5-5/.test(await p.locator('.model-hud-trigger').innerText().catch(() => '')), 'the model card does not show Opus after /model', 10_000);
          assert.equal(await p.locator('.transcript').getByText('/model anthropic', { exact: false }).count(), 0, 'the transcript shows a /model message');
          assert.equal(await box.inputValue(), '', 'the draft was not cleared after a handled command');
          return { model: await p.locator('.model-hud-trigger').innerText(), commandOps: s.requests.filter(r => r.op === 'command').map(r => `${r.name} ${r.args}`) };
        });
        await j.step('complete', 'Type /mo, then /model ; the menu lists /model, then both models with Opus marked current', async () => {
          await box.fill('/mo');
          await p.locator('[data-slash-menu]').getByText('/model', { exact: true }).waitFor({ timeout: 10_000 });
          await box.fill('/model ');
          const menu = p.locator('[data-slash-menu]');
          await menu.getByText('/model anthropic/claude-sonnet-5-5', { exact: true }).waitFor({ timeout: 10_000 });
          const opus = menu.locator('.slash-item', { hasText: 'claude-opus-5-5' });
          assert.match(await opus.innerText(), /current/, 'the current model is not marked');
          await box.fill('');
          return { items: await menu.locator('.slash-item').allInnerTexts().catch(() => []) };
        });
        await j.step('unknown', 'Type /nosuch x and press Enter; nothing is sent, the draft stays, and the composer offers Send as text', async () => {
          const sent = () => s.requests.filter(r => r.op === 'command' || r.op === 'submit').length, before = sent();
          await box.fill('/nosuch x');
          await box.press('Enter');
          const choice = p.locator('[data-command-choice]');
          await choice.waitFor({ timeout: 10_000 });
          const text = await choice.innerText();
          assert.match(text, /Pi has no \/nosuch command\. Nothing was sent\./);
          assert.equal(await box.inputValue(), '/nosuch x', 'the draft was not kept');
          assert.equal(sent(), before, 'an unknown command reached Pi');
          await box.fill('');
          return { choice: text };
        });
        await j.step('escape', 'Type //model is a word and press Enter; Pi gets the message /model is a word as text', async () => {
          await box.fill('//model is a word');
          await box.press('Enter');
          await assertEventually(async () => s.userTexts().includes('/model is a word'), 'the escaped message did not reach Pi as text', 10_000);
          return { users: s.userTexts() };
        });
        await j.step('old-control', 'Open a Session whose control predates A27, type /model anthropic/claude-opus-5-5 and press Enter; AmPi says the control is too old, nothing reaches Pi, and the draft stays', async () => {
          old ??= await addFixture(j, () => addCommandSession(j.state, { id: 'sess-verify-a27-old', pane: 'w1:p28', old: true }), r => [r.thread]);
          await j.goto(`#/h/devbox/t/${encodeURIComponent(old.thread)}`);
          await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === old.thread && t.control === true), 'the Host never lists the old-control Session with a live control', 20_000);
          await box.fill('/model anthropic/claude-opus-5-5');
          await box.press('Enter');
          const choice = p.locator('[data-command-choice]');
          await choice.waitFor({ timeout: 10_000 }).catch(() => {});
          const text = await choice.innerText().catch(() => '');
          assert.deepEqual(old.userTexts().filter(t => t.startsWith('/model')), [], 'the /model command became a user message in the old-control Session');
          assert.equal(old.requests.filter(r => r.op === 'submit').length, 0, 'the /model command reached the old control as text');
          assert.match(text, /too old for slash commands.*Nothing was sent\./s, `the composer shows no too-old notice: "${text}"`);
          assert.equal(await box.inputValue(), '/model anthropic/claude-opus-5-5', 'the draft was not kept');
          return { choice: text, ops: old.requests.map(r => r.op) };
        });
        await j.step('old-control-updated', 'Update the old control in place, then press Enter on the kept draft; the command runs, the model card shows Opus, and nothing reaches Pi as text', async () => {
          old.upgrade();
          // Two status probes after the update: the Host has listed the new capability at least once.
          const probes = old.requests.filter(r => r.op === 'status').length;
          await assertEventually(async () => old.requests.filter(r => r.op === 'status').length >= probes + 2, 'the Host never probed the updated control', 20_000);
          await box.press('Enter');
          await assertEventually(async () => old.model() === 'anthropic/claude-opus-5-5', `Enter on the kept draft did not run /model; the composer shows "${await p.locator('[data-command-choice]').innerText().catch(() => '')}"`, 10_000);
          await assertEventually(async () => /claude-opus-5-5/.test(await p.locator('.model-hud-trigger').innerText().catch(() => '')), 'the model card does not show Opus after the update', 10_000);
          assert.deepEqual(old.userTexts().filter(t => t.startsWith('/model')), [], 'the /model command became a user message');
          assert.equal(old.requests.filter(r => r.op === 'submit').length, 0, 'the /model command reached Pi as text');
          return { model: await p.locator('.model-hud-trigger').innerText(), ops: old.requests.filter(r => r.op !== 'status').map(r => r.op) };
        });
      } finally {
        s.close();
        old?.close();
      }
    },
  },
  {
    id: 'T3e', feature: 't3-open-session.md', title: 'Read whole messages with no raw entry data (A24)',
    async run(j) {
      const p = j.page;
      // Record every thread.entry response from the first socket on.
      const asked = new Set(), responses = [];
      p.on('websocket', ws => {
        ws.on('framesent', f => { try { const m = JSON.parse(String(f.payload)); if (m.t === 'req' && m.op === 'thread.entry') asked.add(m.id); } catch {} });
        ws.on('framereceived', f => { try { const m = JSON.parse(String(f.payload)); if (m.t === 'res' && asked.has(m.id)) responses.push(m); } catch {} });
      });
      const message = text => p.locator('.transcript .msg.assistant', { hasText: text }).first();
      await j.step('open', 'Add the A24 Session, then open it', async () => {
        const thread = addProjectionSession(j.state);
        await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === thread), `the hub does not list ${thread}`, 20_000);
        await j.goto(`#/h/devbox/t/${encodeURIComponent(thread)}`);
        await message('A24-long-start').waitFor({ timeout: 20_000 });
        return { thread };
      });
      await j.step('medium-whole', 'Read the 2.5 KB reply', async () => {
        const msg = message('A24-medium-start');
        const text = await msg.innerText();
        assert(text.includes('A24-medium-end'), 'the 2.5 KB reply is cut');
        // The reply's own controls sit in the message outside its tool cards and thinking, or right after it.
        const controls = await msg.evaluate(el => {
          const own = [...el.querySelectorAll('summary, button')].filter(c => !c.closest('.tool, details.thinking'));
          const next = el.nextElementSibling && !el.nextElementSibling.matches('.msg, .compaction') ? [...el.nextElementSibling.querySelectorAll('summary, button')] : [];
          return [...own, ...next].map(c => c.textContent.trim()).filter(t => /shortened|Show full/i.test(t));
        });
        assert.deepEqual(controls, [], 'the 2.5 KB reply has a shortened control');
        return { chars: text.length };
      });
      await j.step('long-inline', 'Show the full long reply, then read it inline', async () => {
        const msg = message('A24-long-start');
        const show = p.locator('.transcript').getByRole('button', { name: /Show full message/i }).first();
        assert(await show.count(), 'the long reply has no "Show full message" control');
        await show.click();
        await assertEventually(async () => (await msg.innerText()).includes('A24-long-end'), 'the full reply did not render inline', 10_000);
        assert(await msg.locator('h2', { hasText: 'A24 long heading' }).count(), 'the full reply is not rendered as markdown');
        assert(await p.locator('.transcript').getByRole('button', { name: /Show less/i }).count(), 'the full reply has no "Show less" control');
        return { chars: (await msg.innerText()).length };
      });
      await j.step('open-cards', 'Open every shortened card body', async () => {
        const opened = await p.locator('.transcript details').evaluateAll(ds => ds.filter(d => /shortened|Show full/i.test(d.querySelector(':scope > summary')?.textContent ?? '') && !d.open).map(d => { d.open = true; return d.querySelector(':scope > summary').textContent.trim(); }));
        for (const b of await p.locator('.transcript').getByRole('button', { name: /^Show full/i }).all()) await b.click();
        await assertEventually(async () => !(await p.locator('.transcript [role=status]', { hasText: /Reading/ }).count()), 'a card body is still reading', 10_000);
        return { opened };
      });
      await j.step('dom-clean', 'Read the transcript for native entry data', async () => {
        const text = await p.locator('.transcript').evaluate(el => el.textContent);
        const found = [...A24_FORBIDDEN, ...A24_CANARIES].filter(word => text.includes(word));
        const flags = await p.locator('.transcript :is(summary, button, div, p, span)').evaluateAll(es => es.filter(e => /^\s*Preview shortened/.test(e.textContent ?? '') && !e.children.length).length);
        assert.deepEqual(found, [], `the transcript shows native entry data: ${found.join(', ')}`);
        assert.equal(flags, 0, `the transcript has ${flags} full-row "Preview shortened" elements`);
        return { found, flags };
      });
      await j.step('wire-clean', 'Read the captured thread.entry responses', async () => {
        assert(responses.length, 'no thread.entry response was captured');
        const leaks = new Set();
        for (const r of responses) {
          const { keys, strings } = jsonParts(r.value ?? r.error);
          for (const word of A24_FORBIDDEN) {
            const key = word.replaceAll('"', '');
            if (keys.has(key)) leaks.add(`key ${key}`);
            if (word.startsWith('"') && strings.some(s => s.includes(word))) leaks.add(`raw JSON ${word}`);
          }
          for (const canary of A24_CANARIES) if (strings.some(s => s.includes(canary))) leaks.add(`value ${canary}`);
        }
        assert.deepEqual([...leaks], [], `thread.entry responses carry native fields: ${[...leaks].join(', ')}`);
        return { responses: responses.length };
      });
    },
  },
  {
    id: 'T3t', feature: 't3-open-session.md', title: 'Read running, done and interrupted tool calls (A21)',
    async run(j) {
      const p = j.page;
      const a21 = a21Rows(j.state);
      const tool = command => p.locator('.tool', { has: p.locator('.tool-head', { hasText: command }) }).first();
      const stateOf = async command => (await tool(command).locator('.tool-head .state').innerText()).trim();
      await j.step('open-running', 'Start a working pane whose Session has a bash call in flight, then open the Session', async () => {
        await assertEventually(async () => { a21.ensurePane(); const t = (await threadsOf(j.state)).find(x => x.id === `pi:${A21.run}`); return t?.live && t.activity !== 'idle'; }, `pi:${A21.run} is not live and busy`, 30_000);
        await j.goto(`#/h/devbox/t/${encodeURIComponent(`pi:${A21.run}`)}`);
        await tool(A21.command).waitFor({ timeout: 20_000 });
        return { thread: `pi:${A21.run}` };
      });
      await j.step('call-running', 'Read the in-flight bash call', async () => {
        const state = await stateOf(A21.command);
        assert.equal(state, 'running', `the in-flight call shows "${state}"`);
        assert(await tool(A21.command).locator('.tool-head .spinner').count(), 'the in-flight call has no spinner');
        return { state };
      });
      await j.step('call-expands', 'Open the in-flight call', async () => {
        const head = tool(A21.command).locator('.tool-head');
        if (await head.getAttribute('aria-expanded') !== 'true') await head.click();
        const body = tool(A21.command).locator('.tool-body');
        await body.waitFor({ timeout: 3000 }).catch(() => {});
        const text = await body.count() ? await body.innerText() : '';
        assert(text.includes(A21.command), `the expanded call does not show its command: ${JSON.stringify(text.slice(0, 120))}`);
        assert.match(text, /waiting for output/i, 'the expanded call does not say it is waiting for output');
        return { body: text.slice(0, 120) };
      });
      await j.step('overview-running', 'Read the running Session in Overview Running now', async () => {
        await j.goto('#/v/overview');
        const row = p.locator(`[data-card="running"] .row[data-thread="pi:${A21.run}"]`);
        let text = '';
        await assertEventually(async () => { a21.ensurePane(); text = await row.count() ? await row.innerText() : ''; return /running tools/.test(text); }, 'no running tools reason', 15_000).catch(() => {});
        assert.match(text, /running tools/, `Running now does not say "running tools": ${JSON.stringify(text)}`);
        assert.doesNotMatch(text, /interrupted|writing/, `Running now row: ${JSON.stringify(text)}`);
        return { row: text };
      });
      await j.step('timeline-bands', 'Read both A21 bands in Timeline', async () => {
        await j.goto(timeline);
        // A band title comes from its pane title or cwd, so find each band by its Session link.
        const band = id => p.locator('.cos-band-label', { has: p.locator(`a[href*="${encodeURIComponent(`pi:${id}`)}"]`) }).first();
        // The Timeline renders only the bands near its scroll position, and Sessions from other journeys can sort
        // above A21's. Scroll down a screen at a time until the band renders.
        const reach = async (id, ms) => {
          await p.locator('.cos-scroll').waitFor({ timeout: ms });
          const end = Date.now() + ms;
          await p.locator('.cos-scroll').evaluate(e => { e.scrollTop = 0; });
          while (!(await band(id).count())) {
            assert(Date.now() < end, `no Timeline band links ${id}`);
            const moved = await p.locator('.cos-scroll').evaluate(e => { const top = e.scrollTop; e.scrollTop += e.clientHeight * 0.8; return e.scrollTop !== top; });
            if (!moved) await p.locator('.cos-scroll').evaluate(e => { e.scrollTop = 0; });
            await j.settle();
          }
        };
        await reach(A21.run, 20_000);
        await reach(A21.ended, 10_000);
        const ended = await band(A21.ended).innerText();
        assert.equal(await band(A21.ended).locator('.cos-live').count(), 0, 'the ended band shows a live mark');
        await reach(A21.run, 10_000);
        const running = await band(A21.run).innerText();
        assert(await band(A21.run).locator('.cos-live').count(), `the running band shows no live mark: ${JSON.stringify(running)}`);
        assert.doesNotMatch(ended, /running/i, `the ended band claims running: ${JSON.stringify(ended)}`);
        return { running, ended };
      });
      await j.step('ended-interrupted', 'Open the ended Session: the aborted call and the call before a later turn', async () => {
        await j.goto(`#/h/devbox/t/${encodeURIComponent(`pi:${A21.ended}`)}`);
        await tool('echo A21-later-turn').waitFor({ timeout: 20_000 });
        const states = { aborted: await stateOf('echo A21-aborted'), laterTurn: await stateOf('echo A21-later-turn') };
        assert.deepEqual(states, { aborted: 'interrupted', laterTurn: 'interrupted' });
        return states;
      });
      await j.step('call-done', 'The bash result arrives; read the call again', async () => {
        a21.ensurePane();
        a21.result();
        await j.goto(`#/h/devbox/t/${encodeURIComponent(`pi:${A21.run}`)}`);
        await tool(A21.command).waitFor({ timeout: 20_000 });
        let state;
        await assertEventually(async () => (state = await stateOf(A21.command)) === 'done', 'the call did not turn done', 15_000).catch(() => {});
        assert.equal(state, 'done', `after its result the call shows "${state}"`);
        return { state };
      });
    },
  },
  {
    id: 'T3a', feature: 't3a-arcs.md', title: 'Read the Arcs',
    async run(j) {
      const p = j.page;
      await autoBuildsSettled(j.state);
      await j.step('inventory', 'Choose Arcs', async () => {
        await j.goto('#/v/arcs');
        const row = p.locator('.cos-list-row').first();
        await row.waitFor();
        const meta = await p.locator('.cos-header .cos-meta').innerText();
        assert.match(meta, /^\d+ long-running Sessions?/);
        // The demo's stopped Sessions build automatically at hub start (D16 option A); wait for that head here,
        // so later steps measure only their own model calls.
        const big = p.locator('.cos-list-row').filter({ has: p.locator('.cos-session-name a[href*="pi%3Asess-big"]') }).locator('.cos-arc-head');
        await big.waitFor({ timeout: 30_000 });
        const context = await big.innerText();
        assert.match(context, /Needs you/, 'Arcs list Context column shows no open asks for the big Session');
        return { meta, rows: await p.locator('.cos-list-row').count(), context };
      });
      let estimateCalls;
      await j.step('open-arc', 'Open the big Session Arc from the inventory', async () => {
        await p.locator('.cos-session-name a[href*="pi%3Asess-big"]').click();
        await p.waitForURL(/arcs\/devbox(?:%23pi)?\/pi%3Asess-big/);
        await p.getByRole('heading', { level: 1, name: /^Arc · / }).waitFor();
        const toolbar = await p.locator('.cos-toolbar span').first().innerText();
        assert.match(toolbar, /^devbox · (\d+) chunks · [1-9]\d* labelled$/);
        const builds = await p.locator('.cos-builds summary').innerText();
        assert.match(builds, /Arc updated automatically · \d+ calls?/);
        const caption = await p.locator('.cos-caption').first().innerText();
        estimateCalls = num(/· ([\d,]+) calls/.exec(caption)[1]);
        // The estimate names its main cost: synthesis rereads the whole Session on every Build.
        assert.match(caption, /calls · synthesis rereads the whole Session/, `estimate: ${caption}`);
        // The automatic Build's price sits beside the estimate.
        assert.match(caption, / · last Build: (?:[\d,]+ input tokens, )?(?:\$[\d.,]+|price unavailable)\.$/, `estimate: ${caption}`);
        const chunksRegion = p.getByRole('region', { name: 'Chunks over time' });
        await chunksRegion.waitFor();
        // The legend states the live chunk rule; harness wakes and directory moves never cut a chunk.
        const rule = await chunksRegion.locator('.cos-meta').first().innerText();
        assert.match(rule, /^A chunk starts at an owner turn after 12 owner turns, 40k Rarebit characters, or more than 2 h without owner-driven activity\. Compactions, harness wakes and directory moves stay inside a chunk\./, `legend: ${rule}`);
        return { toolbar, builds, estimateCalls };
      }, { expectSide: s => assert.equal(s.askCalls, 0, 'opening an Arc called the model') });
      await j.step('tier-two-context', 'Read Needs you and the Work tree', async () => {
        const tree = p.getByRole('region', { name: 'Evergreen context' });
        const first = await tree.getByRole('heading', { level: 2 }).first().innerText();
        assert.match(first, /^Needs you \d+/, `first branch is ${first}`);
        const kinds = await tree.getByRole('heading', { level: 3 }).allInnerTexts();
        for (const kind of ['Decision', 'Approval', 'Input', 'Blocker']) assert(kinds.includes(kind), `no ${kind} branch`);
        await tree.getByRole('heading', { level: 2, name: /^Work tree/ }).waitFor();
        // Citations are Session-qualified: each one opens an entry in this Session.
        const cites = await tree.getByRole('link', { name: /^\[#/ }).evaluateAll(as => as.map(a => a.getAttribute('href')));
        assert(cites.length >= 4, `only ${cites.length} citations`);
        for (const h of cites) assert.match(h, /\/t\/pi%3Asess-big\?e=/, `citation ${h} leaves the Session`);
        return { first, kinds: kinds.slice(0, 6), citations: cites.length };
      }, { expectSide: s => assert.equal(s.askCalls, 0, 'reading the tree called the model') });
      await j.step('build-arc', 'Choose Build arc', async () => {
        const button = p.getByRole('button', { name: /^(Build arc|Building arc…)$/ });
        await button.click();
        await p.getByRole('button', { name: 'Build arc', exact: true }).waitFor({ timeout: 30_000 });
        // Lane 4: a Build makes exactly the estimated calls; the Build log records them.
        let last;
        await assertEventually(async () => /^Builds · last: Arc built on request/.test(last = await p.locator('.cos-builds summary').innerText()), 'no manual Build in the Build log', 10_000).catch(() => {});
        assert.match(last, /^Builds · last: Arc built on request · (\d+) calls?/, `Build log: ${last}`);
        const calls = num(/on request · (\d+) call/.exec(last)[1]);
        assert.equal(calls, estimateCalls, `Build made ${calls} calls; estimate said ${estimateCalls}`);
        const projects = await p.getByRole('region', { name: 'Projects' }).locator('.cos-project').count();
        assert(projects >= 1, 'no project cards');
        // One currency rule: a finished Build with no newer Rarebit message reads current, with no rebuild prompt.
        const headline = await p.locator('.cos-headline .cos-meta').innerText();
        assert.match(headline, / · current$/, `headline meta: ${headline}`);
        return { last, calls, estimateCalls, projects, headline };
      }, { expectSide: s => assert(s.askCalls >= 1, 'Build arc made no model call'), startsBuild: true });
      // A28 and M2: the demo hub's config names Haiku for Arc labels and Sonnet for synthesis. The newest Build row names both.
      await j.step('build-model', 'Open the Build log; the newest Build names claude-haiku-5-5 and claude-sonnet-5-5', async () => {
        const log = p.locator('.cos-builds');
        if (!(await log.evaluate(d => d.open))) await log.locator('summary').click();
        const row = log.locator('li').first();
        await row.waitFor({ timeout: 5000 });
        const seen = { text: await row.innerText(), title: (await row.getAttribute('title')) ?? '' };
        assert.match(seen.text, /claude-haiku-5-5 \+ claude-sonnet-5-5/, `newest Build row: ${JSON.stringify(seen)}`);
        return seen;
      });
      // Arc chunk invalidation: labels from an older chunker never show as labels; the page says a relabel is pending.
      // Owner decision: a cut ask title keeps its start, shows a mark that more text exists, and opens the full text on
      // one click. The mark is ink left of the title inside its row, as for every disclosure row (T3d).
      await j.gap('arc-titles-2', 'cut-ask-title', 'In the Arc tree, read a cut ask before and after one click', async () => {
        const leaf = p.locator('details.cos-leaf').filter({ has: p.locator(':scope > p') }).filter({ has: p.locator('.cos-badge') }).first();
        await leaf.waitFor({ timeout: 10_000 });
        await leaf.scrollIntoViewIfNeeded();
        const before = await leaf.evaluate(d => {
          const s = d.querySelector(':scope > summary'), t = s.querySelector('.cos-leaf-title');
          const sr = s.getBoundingClientRect(), tr = t.getBoundingClientRect();
          return { open: d.open, title: t.textContent, full: d.querySelector(':scope > p').textContent, fullVisible: d.querySelector(':scope > p').checkVisibility(),
            region: { x: Math.round(sr.left), y: Math.round(sr.top), width: Math.floor(tr.left - sr.left), height: Math.round(sr.height) } };
        });
        const problems = [];
        const start = before.title.replace(/…$/, '').trim();
        if (!before.title.endsWith('…')) problems.push(`the cut title has no ellipsis: "${before.title}"`);
        if (!before.full.replace(/\s+/g, ' ').startsWith(start)) problems.push(`the cut title is not the start of the ask: "${before.title}" vs "${before.full.slice(0, 80)}"`);
        if (before.open || before.fullVisible) problems.push('the full text shows before any click');
        let ink = 0;
        if (before.region.width >= 2) {
          const png = (await p.screenshot()).toString('base64');
          ink = await p.evaluate(async ({ png, region }) => {
            const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
            const c = document.createElement('canvas'); c.width = region.width; c.height = region.height;
            const g = c.getContext('2d'); g.drawImage(img, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
            const d = g.getImageData(0, 0, c.width, c.height).data, bg = [d[0], d[1], d[2]];
            let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) > 48) n++;
            return n;
          }, { png, region: before.region });
        }
        if (ink < 4) problems.push(`no disclosure mark left of the cut title (${before.region.width} px, ${ink} inked px)`);
        await leaf.locator(':scope > summary').click();
        const after = await leaf.evaluate(d => ({ open: d.open, fullVisible: d.querySelector(':scope > p').checkVisibility() }));
        if (!after.open || !after.fullVisible) problems.push('one click did not show the full ask');
        await leaf.locator(':scope > summary').click();
        assert.equal(problems.length, 0, problems.join('; '));
        return { title: before.title, ink };
      });
      await j.step('old-chunker-arc', 'Open an Arc stored under ampi-arc-chunker/2 for unchanged Session input', async () => {
        // Opening an outdated Arc starts an upgrade Build. Block the demo model while the page is read, so the Build
        // can neither relabel before the read nor spend model calls inside the next step.
        const block = join(j.state.demo, 'cos-no-model');
        writeFileSync(block, '');
        try {
          const threadId = addOldChunkerArc(j.state);
          await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === threadId), `the hub does not list ${threadId}`, 20_000);
          await j.goto(`#/v/arcs/devbox/${encodeURIComponent(threadId)}`);
          await p.getByRole('heading', { level: 1, name: /^Arc · / }).waitFor();
          await p.locator('.cos-chunk').first().waitFor({ timeout: 20_000 });
          const text = await p.locator('main, .app').first().innerText();
          const rows = await p.locator('.cos-chunk').evaluateAll(cs => cs.map(c => c.dataset.state));
          const problems = [];
          if (text.includes(OLD_CHUNKER_TOPIC)) problems.push(`${text.split(OLD_CHUNKER_TOPIC).length - 1} old-chunker topics show`);
          // The legend names every state; only chunk rows and their dividers may not read "stale label".
          const stale = await p.locator('.cos-chunk[data-state="stale"], .cos-chunk-divider[data-state="stale"]').count();
          const staleText = await p.locator('.cos-chunk, .cos-chunk-divider').filter({ hasText: /stale label/i }).count();
          if (stale || staleText) problems.push(`${stale} stale chunk rows or dividers, ${staleText} reading "stale label"`);
          // Each row's state colour pairs with one legend key; the relabel key carries the copy.
          const pending = rows.filter(state => state === 'relabel').length;
          if (pending !== rows.length) problems.push(`${pending} of ${rows.length} chunk rows are in state relabel`);
          const key = await p.locator('.cos-chunk-legend [data-state="relabel"]').allInnerTexts();
          if (!key.some(k => /relabel pending/i.test(k))) problems.push('the legend has no "relabel pending" key');
          const toolbar = await p.locator('.cos-toolbar span').first().innerText();
          assert.equal(problems.length, 0, `${problems.join('; ')} · toolbar: ${toolbar}`);
          // Let the blocked upgrade Build fail before the model returns.
          await assertEventually(async () => /failed/i.test(await p.locator('.cos-builds summary').innerText().catch(() => '')), '', 15_000).catch(() => {});
          return { toolbar, rows: rows.length, pending };
        } finally {
          rmSync(block, { force: true });
        }
      });
      await j.step('arc-panel', 'Open the Session, then choose Arc in its toolbar', async () => {
        await j.goto(thread('big'));
        await p.locator('.composer').waitFor();
        const toggle = p.locator('.rb-controls').getByRole('button', { name: 'Arc', exact: true });
        await toggle.click();
        const panel = p.locator('[data-panel="arc"]');
        await panel.getByRole('link', { name: 'Full Arc page' }).waitFor();
        await panel.getByRole('heading', { level: 2, name: /^Needs you/ }).waitFor();
        assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
        const lastBuild = await panel.locator('.cos-arc-last-build').innerText({ timeout: 5_000 }).catch(() => '');
        assert.match(lastBuild, /^Last Build · Arc built on request · .* · claude-haiku-5-5 \+ claude-sonnet-5-5$/, `panel last Build: ${lastBuild}`);
        // Short titles: an ask carries its kind and a thread its state as badges; titles keep their limits.
        const titles = await panel.evaluate(el => ({
          asks: [...el.querySelectorAll('.cos-leaf-title')].filter(t => t.parentElement.querySelector('.cos-badge')).map(t => t.textContent),
          leaves: [...el.querySelectorAll('.cos-leaf-title')].map(t => t.textContent),
          threads: [...el.querySelectorAll('.cos-context-thread > h3')].filter(h => h.textContent !== 'Unassigned').map(h => ({ label: h.firstChild.textContent.trim(), badge: h.querySelector('.cos-badge')?.textContent ?? null })),
        }));
        assert(titles.asks.length >= 1, 'no ask shows a kind badge');
        assert(titles.threads.length >= 1 && titles.threads.every(t => /^(active|paused|done|unclear)$/.test(t.badge ?? '')), `thread state badges: ${JSON.stringify(titles.threads)}`);
        for (const t of titles.asks) assert(t.length <= 60, `ask title over 60: ${t}`);
        const stated = /^[[(]?(active|paused|done|unclear)[\])]?\s*[:|·–—-]|[|·:([–—-]\s*(active|paused|done|unclear)[\])]?$/i;
        for (const t of titles.threads) assert(t.label.length <= 40 && !stated.test(t.label), `thread label: ${t.label}`);
        for (const t of titles.leaves) assert(t.length <= 90, `leaf title over 90: ${t}`);
        await toggle.click();
        await panel.waitFor({ state: 'detached' });
        return { pressed: true, lastBuild, asks: titles.asks.slice(0, 3), threads: titles.threads.slice(0, 3), leaves: titles.leaves.length };
      }, { expectSide: s => assert.equal(s.askCalls, 0, 'the Arc panel called the model') });
      await j.step('cite-jump-lands', 'From another Session, follow a citation to one of the last asks in a long Session', async () => {
        // The target Session was read before, so its cached view arrives at once; the jump must stay in view while
        // the deferred paint window adds rows above it.
        await j.goto(thread('asks'));
        await p.locator('.composer').waitFor();
        const landed = {};
        for (const want of ['asks-a80', 'asks-a100']) {
          await j.goto(thread('big'));
          await p.locator('.composer').waitFor();
          await j.goto(`${thread('asks')}?e=${want}`);
          // Under host load the first paint can take seconds; sample only once the entry exists.
          await p.locator(`[data-entry="${want}"]`).first().waitFor({ state: 'attached', timeout: 10_000 });
          const tops = [];
          for (let i = 0; i < 3; i++) {
            await p.waitForTimeout(250);
            const at = await p.evaluate(id => {
              const box = document.querySelector('.scroll')?.getBoundingClientRect();
              const el = document.querySelector(`[data-entry="${CSS.escape(id)}"]`)?.getBoundingClientRect();
              return box && el ? { top: Math.round(el.top - box.top), bottom: Math.round(el.bottom - box.top), height: Math.round(box.height) } : undefined;
            }, want);
            assert(at, `${want} is not rendered`);
            assert(at.bottom > 0 && at.top < at.height, `${want} left the view: top ${at.top}, bottom ${at.bottom}, view ${at.height}`);
            tops.push(at.top);
          }
          landed[want] = tops;
        }
        return landed;
      }, { expectSide: s => assert.equal(s.askCalls, 0, 'a citation jump called the model') });
    },
  },
  {
    id: 'F1', feature: 'f1-find.md', title: 'Find text across Sessions and in one Session',
    async run(j) {
      const p = j.page;
      await autoBuildsSettled(j.state);
      await j.goto('#/v/overview');
      await j.step('fleet-search', 'Open Search copied prose in the sidebar and search a phrase from one Session\'s first turn', async () => {
        const box = p.locator('details.fleet-search');
        await box.locator('summary').click();
        // The big Session's first human turn; no other demo Session says it.
        await box.getByRole('textbox', { name: 'Search copied prose' }).fill('keep the Rarebit selector honest');
        await box.getByRole('textbox', { name: 'Search copied prose' }).press('Enter');
        const status = box.getByRole('status').first();
        await status.waitFor({ timeout: 15_000 });
        const text = await status.innerText();
        const hits = num(/^(\d+) results/.exec(text)?.[1] ?? '');
        assert(hits >= 1, `fleet search: ${text}`);
        const hit = box.locator('a[href*="pi%3Asess-big"]').first();
        const target = await hit.getAttribute('href');
        await hit.click();
        await p.waitForURL(/\/t\/pi%3Asess-big\?e=/);
        return { status: text, target };
      }, { expectSide: s => assert.equal(s.askCalls, 0, 'search called the model') });
      await j.step('find-in-session', 'Choose Find in the Session toolbar and search a tool-call phrase', async () => {
        await p.locator('.composer').waitFor();
        await p.getByRole('button', { name: 'Find', exact: true }).click();
        const find = p.getByRole('region', { name: 'Find in this Session' });
        const input = find.getByRole('textbox', { name: 'Find in Session' });
        await input.fill('step 570');
        await input.press('Enter');
        const status = find.getByRole('status');
        await status.waitFor({ timeout: 15_000 });
        const text = await status.innerText();
        assert.match(text, /^[1-9]\d* matching entries · \d+ scanned/);
        const target = await find.locator('a').first().getAttribute('href');
        assert.match(target, /\/t\/pi%3Asess-big\?e=/);
        return { status: text, target };
      }, { expectSide: s => assert.equal(s.askCalls, 0, 'find called the model') });
    },
  },
  {
    id: 'T3b', feature: 't3b-rarebit.md', title: 'Read Rarebit messages',
    async run(j) {
      const p = j.page;
      await j.goto(thread('worker-gui', 'rarebit'));
      await p.locator('.rb-message').first().waitFor();
      await j.step('retired-derivations', 'Read Rarebits and open Models; Summary and Recap have no controls', async () => {
        assert.equal(await p.getByRole('button', { name: /^(Recap|Summary)$/ }).count(), 0);
        await p.locator('.rb-controls').getByRole('button', { name: 'Timeline', exact: true }).waitFor();
        await p.locator('.rb-controls').getByRole('button', { name: 'Arc', exact: true }).waitFor();
        await p.getByRole('button', { name: 'Models', exact: true }).click();
        await p.getByLabel('Side ask model', { exact: true }).waitFor();
        assert.equal(await p.getByLabel('Recap model', { exact: true }).count(), 0);
        assert.equal(await p.locator('.rb-view [role="alert"]').count(), 0);
        await p.getByRole('button', { name: 'Models', exact: true }).click();
        return { messages: await p.locator('.rb-message').count(), retiredControls: 0 };
      }, { expectSide: s => assert.equal(s.askCalls, 0, 'reading Rarebits called the model') });
      await j.step('top-row', 'Read the Rarebit top row', async () => {
        const meta = await p.locator('.rb-header .rb-meta').first().innerText();
        for (const name of ['Diagnosis', 'Models']) await p.getByRole('button', { name, exact: true }).waitFor();
        await p.getByRole('button', { name: /^(Hide|Show) continuations$/ }).waitFor();
        return { meta };
      });
      await j.step('prev-next', 'Choose Previous user message, then Next user message', async () => {
        const top = () => rbScroll(p).evaluate(e => Math.round(e.scrollTop));
        const start = await top();
        await p.getByLabel('Previous user message', { exact: true }).click();
        await assertEventually(async () => (await top()) < start, 'Previous did not move up');
        await j.settle();
        const prev = await top();
        await p.getByLabel('Next user message', { exact: true }).click();
        await assertEventually(async () => (await top()) > prev, 'Next did not move down');
        await j.settle();
        const next = await top();
        assert(prev < start, `Previous did not move up (${start} → ${prev})`);
        assert(next > prev, `Next did not move down (${prev} → ${next})`);
        return { start, prev, next };
      });
      const anchor = async () => rbScroll(p).evaluate(e => {
        const box = e.getBoundingClientRect();
        const items = [...e.querySelectorAll('.rb-message.rb-stop[data-rarebit], .rb-message.rb-user[data-rarebit]')];
        const first = items.find(i => i.getBoundingClientRect().top >= box.top);
        return first && { id: first.dataset.rarebit, y: Math.round(first.getBoundingClientRect().top - box.top), atBottom: e.scrollTop + e.clientHeight >= e.scrollHeight - 2 };
      });
      await j.step('hide-continuations', 'Choose Previous user message, then Hide continuations', async () => {
        // At the bottom a shorter list clamps scrollTop, so place keeping is only defined above the bottom.
        await p.getByLabel('Previous user message', { exact: true }).click();
        await assertEventually(async () => (await anchor())?.atBottom === false, 'Previous did not leave the bottom');
        await j.settle();
        const before = await anchor();
        await p.getByRole('button', { name: 'Hide continuations', exact: true }).click();
        await p.getByRole('button', { name: 'Show continuations', exact: true }).waitFor();
        await j.settle();
        const after = await rbScroll(p).evaluate((e, id) => { const el = e.querySelector(`[data-rarebit="${CSS.escape(id)}"]`); return el && Math.round(el.getBoundingClientRect().top - e.getBoundingClientRect().top); }, before.id);
        assert(after !== null, 'anchor message vanished');
        assert(Math.abs(after - before.y) <= 2, `anchor moved ${before.y} → ${after}`);
        return { anchor: before.id, before: before.y, after };
      });
      // I17 at 39b5240: the first visible message stays first but moves down 24 px (one continuation row).
      await j.gap('I17', 'show-keeps-place', 'Choose Show continuations; the first visible message must not move', async () => {
        const before = await anchor();
        await p.getByRole('button', { name: 'Show continuations', exact: true }).click();
        await p.getByRole('button', { name: 'Hide continuations', exact: true }).waitFor();
        await j.settle();
        const after = await anchor();
        assert.equal(after.id, before.id, `first visible message changed ${before.id} → ${after.id}`);
        assert(Math.abs(after.y - before.y) <= 2, `first visible message moved ${before.y} → ${after.y}`);
        return { before, after };
      });
      // As T3d scroll-survives-render, for the Rarebit view: a click before the scroll event must not pull the reader back.
      await j.step('scroll-survives-click', 'Scroll from the bottom to the top and toggle continuations before the scroll event; the top stays', async () => {
        await p.getByRole('button', { name: '↓ Bottom', exact: true }).click();
        await assertEventually(async () => (await anchor())?.atBottom === true, '↓ Bottom did not reach the bottom');
        await j.settle();
        const toggle = p.getByRole('button', { name: /^(Hide|Show) continuations$/ });
        // The toggle keeps the first visible message at its screen height (hide-continuations), so measure that message.
        const after = await rbScroll(p).evaluate(async (el, button) => {
          el.scrollTop = 0;
          const box = el.getBoundingClientRect();
          const first = [...el.querySelectorAll('.rb-message.rb-stop[data-rarebit], .rb-message.rb-user[data-rarebit]')].find(i => i.getBoundingClientRect().top >= box.top);
          const y = node => node && Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top);
          const before = y(first);
          button.click();
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
          const now = first && el.querySelector(`[data-rarebit="${CSS.escape(first.dataset.rarebit)}"]`);
          return { id: first?.dataset.rarebit, before, after: y(now), top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
        }, await toggle.elementHandle());
        await toggle.click();
        await j.settle();
        assert(after.id && after.gap > 2 && after.after !== null && Math.abs(after.after - after.before) <= 2, `the click moved the reader: message ${after.id} ${after.before} → ${after.after}, scrollTop ${after.top}, ${after.gap} px above the bottom`);
        return after;
      });
      await j.step('lens-keeps-place', 'In the transcript middle, toggle the conversation lens on and off', async () => {
        const scroll = p.locator('.scroll').first();
        await scroll.evaluate(e => { e.scrollTop = e.scrollHeight / 2; });
        await j.settle();
        const mark = () => scroll.evaluate(e => {
          const box = e.getBoundingClientRect();
          const first = [...e.querySelectorAll('.msg.user[data-entry]')].find(n => n.getBoundingClientRect().top >= box.top);
          return first && { entry: first.dataset.entry, y: Math.round(first.getBoundingClientRect().top - box.top) };
        });
        const before = await mark();
        await p.getByRole('button', { name: 'Transcript lens: full transcript', exact: true }).click();
        await p.getByRole('button', { name: 'Transcript lens: conversation only', exact: true }).waitFor();
        await p.getByRole('button', { name: 'Transcript lens: conversation only', exact: true }).click();
        await p.getByRole('button', { name: 'Transcript lens: full transcript', exact: true }).waitFor();
        await j.settle();
        const after = await scroll.evaluate((e, id) => { const el = e.querySelector(`[data-entry="${CSS.escape(id)}"]`); return el && Math.round(el.getBoundingClientRect().top - e.getBoundingClientRect().top); }, before.entry);
        assert(after !== null && Math.abs(after - before.y) <= 4, `entry ${before.entry} moved ${before.y} → ${after}`);
        return { entry: before.entry, before: before.y, after };
      });
      await j.step('tool-run-line', 'Turn on the conversation lens and read a folded tool run', async () => {
        await p.getByRole('button', { name: 'Transcript lens: full transcript', exact: true }).click();
        // Thinking-only runs fold as "thinking · 20s · …"; read the first run that has tool calls.
        const summary = p.locator('.rb-tools summary').filter({ hasText: /^\d+ tool calls?\b/ }).first();
        await summary.waitFor();
        const text = (await summary.innerText()).replace(/\s+/g, ' ');
        assert.match(text, /^\d+ tool calls?(, \d+ [^,·]+)* · .+ · \d\d:\d\d–\d\d:\d\d/);
        return { summary: text };
      });
      await j.step('compaction-kept', 'Open the lead Session Rarebit and load earlier messages until a compaction shows', async () => {
        await j.goto(thread('lead', 'rarebit'));
        await p.locator('.rb-message').first().waitFor();
        for (let i = 0; i < 6 && !(await p.locator('.rb-compaction').count()); i++) {
          const earlier = p.getByRole('button', { name: /^Show 60 earlier/ });
          if (!(await earlier.count())) break;
          const shown = await p.locator('.rb-message').count();
          await earlier.click();
          await assertEventually(async () => (await p.locator('.rb-message').count()) > shown || (await p.locator('.rb-compaction').count()) > 0, 'Show 60 earlier loaded nothing');
        }
        const marker = p.locator('.rb-compaction').first();
        await marker.waitFor();
        return { marker: (await marker.innerText()).trim() };
      });
    },
  },
  {
    id: 'T3m', feature: 't3b-rarebit.md', title: 'Read a mixed run in the conversation lens (A26b)',
    async run(j) {
      const p = j.page;
      await j.step('open', 'Add the A26b Session, then open it with the full transcript', async () => {
        const thread = addMixedRunSession(j.state);
        await assertEventually(async () => (await threadsOf(j.state)).some(t => t.id === thread), `the hub does not list ${thread}`, 20_000);
        await j.goto(`#/h/devbox/t/${encodeURIComponent(thread)}`);
        await p.getByText('A26b-after', { exact: false }).first().waitFor({ timeout: 20_000 });
        await p.getByRole('button', { name: 'Transcript lens: full transcript', exact: true }).waitFor();
        const notices = await p.locator('.msg.notice').count();
        assert.equal(notices, 4, `the full transcript shows ${notices} extension messages`);
        return { thread, notices };
      });
      // Outside a run, nothing but user and assistant text renders.
      const loose = () => p.locator('.msg.notice, .compaction, .tool').evaluateAll(els => els.filter(e => !e.closest('.rb-tools')).map(e => e.textContent.slice(0, 60)));
      await j.step('one-run', 'Turn on the conversation lens and read the folded run', async () => {
        await p.getByRole('button', { name: 'Transcript lens: full transcript', exact: true }).click();
        await p.getByRole('button', { name: 'Transcript lens: conversation only', exact: true }).waitFor();
        await j.settle();
        const summaries = (await p.locator('.rb-tools summary').allInnerTexts()).map(t => t.replace(/\s+/g, ' '));
        assert.equal(summaries.length, 1, `runs: ${JSON.stringify(summaries)}`);
        assert.match(summaries[0], /^2 tool calls, 1 PTB msg, 1 intercom msg, 1 compaction, 2 Auto Compact msgs · /);
        assert.deepEqual(await loose(), []);
        return { summary: summaries[0] };
      });
      await j.step('run-opens', 'Open the run; every step shows inside it', async () => {
        await p.locator('.rb-tools summary').click();
        await assertEventually(async () => (await p.locator('.rb-tools .msg.notice').count()) === 4, 'the open run lacks its 4 extension messages');
        assert.equal(await p.locator('.rb-tools .compaction').count(), 1);
        assert.deepEqual(await loose(), []);
        return { notices: 4, compactions: 1 };
      });
    },
  },
  {
    id: 'S', feature: 's-sidebar.md', title: 'Read Teams in the sidebar: leaders fold their Workers (L15)',
    async run(j) {
      const p = j.page, leaders = p.locator('.side-scroll .row[data-leader-row]');
      const workers = () => p.locator('.side-scroll .row[data-row-level="2"]').count();
      await j.goto('#/v/overview');
      await j.step('collapsed', 'Open AmPi; every Team leader starts collapsed with its Worker count', async () => {
        await assertEventually(async () => (await leaders.count()) >= 2, 'the demo hub shows fewer than 2 Team leader rows', 20_000);
        const counts = await leaders.evaluateAll(rows => rows.map(r => Number(r.querySelector('[data-worker-count]')?.textContent.replace(/[^\d]/g, '') ?? -1)));
        assert(counts.every(n => n > 0), `leader Worker counts: ${JSON.stringify(counts)}`);
        assert.equal(await workers(), 0, 'Worker rows show before any leader is expanded');
        return { leaders: counts.length, counts };
      });
      // The owner's hub starts Teams while AmPi is open; a leader that appears later starts collapsed too.
      await j.step('late-team', 'Start a third Team after the page loads; its leader starts collapsed with its Worker count', async () => {
        // No agent stop, so no automatic Build; each new Session still gets a derive, which calls the model.
        const { ensure, ...late } = await j.fixture(async () => {
          const r = addLateTeam(j.state);
          await assertEventually(async () => { r.ensure(); const ids = new Set((await threadsOf(j.state)).map(t => t.id)); return ids.has(r.lead) && ids.has(r.worker); }, 'the hub does not list the late Team', 30_000);
          return r;
        });
        const row = p.locator(`.side-scroll .row[data-leader-row][data-thread="${late.lead}"]`);
        await assertEventually(async () => { ensure(); return (await row.count()) === 1; }, 'the late Team leader row never appeared', 30_000);
        await assertEventually(async () => { ensure(); return (await row.count()) === 1 && (await p.locator(`.side-scroll .row[data-parent-leader][data-thread="${late.worker}"]`).count()) === 0
          && (await row.locator('[data-worker-count]').count()) === 1; }, 'the late Team leader shows its Workers or no Worker count', 15_000);
        return { ...late, count: Number((await row.locator('[data-worker-count]').innerText()).replace(/[^\d]/g, '')) };
      });
      await j.step('expand-one', 'Open one leader; its Workers show one level in, under their own names', async () => {
        const toggle = leaders.first().locator('[data-collapse-toggle]');
        const expected = Number((await leaders.first().locator('[data-worker-count]').innerText()).replace(/[^\d]/g, ''));
        await toggle.click();
        await assertEventually(async () => (await workers()) === expected, `expected ${expected} Worker rows after opening the leader`);
        const shape = await p.evaluate(() => {
          const rows = [...document.querySelectorAll('.side-scroll .row[data-row-level="2"] .title')];
          const team = rows[0].closest('.row').getAttribute('data-parent-leader');
          const lead = document.querySelector(`.side-scroll .row[data-leader-row="${team}"] .title`);
          const name = lead.textContent.trim().toLowerCase();
          return { indent: Math.round(rows[0].getBoundingClientRect().x - lead.getBoundingClientRect().x), labels: rows.map(r => r.textContent.trim()), repeat: rows.some(r => r.textContent.trim().toLowerCase().includes(name)), idleMarkers: document.querySelectorAll('.side-scroll .idle-dot').length };
        });
        assert(shape.indent >= 12, `Worker indent ${shape.indent}px; expected at least 12px`);
        assert(!shape.repeat, `a Worker label repeats its leader label: ${JSON.stringify(shape.labels)}`);
        assert.equal(shape.idleMarkers, 0, 'an idle row renders a constant marker');
        return { expected, ...shape };
      });
      await j.step('collapse-all', 'Use the Host control to collapse all Teams, then expand all', async () => {
        const all = p.locator('[data-host-collapse-all]').first();
        for (let i = 0; i < 2 && await workers(); i++) await all.click();
        await assertEventually(async () => (await workers()) === 0, 'Worker rows remain after Collapse all');
        await all.click();
        const folded = await leaders.evaluateAll(rows => rows.reduce((n, r) => n + Number(r.querySelector('[data-worker-count]')?.textContent.replace(/[^\d]/g, '') ?? 0), 0));
        await assertEventually(async () => (await workers()) > 0 && (await p.locator('.side-scroll [data-worker-count]').count()) === 0, 'Expand all left Teams folded');
        return { label: await all.innerText(), workers: await workers(), foldedBefore: folded };
      }, { expectSide: s => assert.equal(s.herdrTotal, 0, 'folding Teams sent a Herdr action'), alone: false });
    },
  },
  {
    id: 'C', feature: 'c-control.md', title: 'Pi control at the hub wire: presence, abort, ack (L14)',
    async run(j) {
      // One disposable hub with a real remote agent and two fake hc-control endpoints; no browser page is needed.
      // Steps follow merge order (ctlabort, ctlpresence, ctllatency), so each parent commit fails on its own step.
      const verdict = await harnessSeed('control-seed.ts');
      const part = (key, why) => { const v = verdict[key]; assert(v?.ok, `${why}: ${v?.reason ?? verdict.reason ?? 'no verdict'}`); return v; };
      await j.step('abort-returned', 'Abort a busy Session with a queued follow-up; the reply and the inbox name it as returned', async () =>
        part('abort', 'abort (ctlabort)'), { alone: false });
      await j.step('presence', 'A live control descriptor without a Session file lists a live row; its first words go to the control socket', async () =>
        part('presence', 'presence (ctlpresence)'), { alone: false });
      await j.step('ack-overtakes', 'Submit while a 160 MB Session streams; the hub parses the ack before 3 MiB more Session bytes', async () =>
        part('ack', 'ack lane (ctllatency)'), { alone: false });
    },
  },
  {
    id: 'K1', feature: 'k1-keys.md', title: 'Move through AmPi with the keyboard (keymap items 1, 2, 3, 4, 6, 7)',
    async run(j) {
      const p = j.page;
      // In-page key events only: they prove the app's keymap, not what the OS or a native shell passes through.
      // Waits return when their check holds; 10 s covers a hub under parallel journey load.
      const region = () => p.evaluate(() => document.activeElement?.closest('[data-region]')?.getAttribute('data-region') ?? null);
      const regionIs = async (name, message) => assertEventually(async () => (await region()) === name, `${message}; focus is in ${await region()}`, 10_000);
      const sidebarHidden = () => p.evaluate(() => Boolean(document.querySelector('[data-region="sidebar"]')?.closest('[inert]')));
      const scrollOf = selector => p.evaluate(s => Math.round(document.querySelector(s)?.scrollTop ?? -1), selector);
      const zoom = () => p.evaluate(() => ({ html: getComputedStyle(document.documentElement).zoom, stored: JSON.parse(localStorage.getItem('ampi.display') ?? '{}').overall ?? null }));
      const transcript = '[data-region="transcript"]';
      const focusTranscript = async () => { await p.locator(transcript).click({ position: { x: 20, y: 20 } }); await regionIs('transcript', 'a click did not focus the transcript'); };
      await j.step('sidebar', 'In a long Session, press ⌘B three times: focus the sidebar, hide it and return, show and focus it', async () => {
        // Open the Session from its sidebar row: a direct route before the Host lists it can stay "Unknown Session".
        await j.goto('#/v/overview');
        await p.locator('.side-scroll .row[data-thread="pi:sess-big"] a.title').click({ timeout: 15_000 });
        await p.waitForURL(/\/t\/pi%3Asess-big/);
        await p.locator(transcript).waitFor({ timeout: 15_000 });
        // The composer renders once the Session view arrives; ⌘I and the focus return need it.
        await p.getByRole('textbox', { name: 'Message the agent' }).waitFor({ timeout: 15_000 });
        await focusTranscript();
        await p.keyboard.press('ControlOrMeta+b');
        await regionIs('sidebar', '⌘B did not focus the visible sidebar');
        await p.keyboard.press('ControlOrMeta+b');
        await assertEventually(sidebarHidden, 'the second ⌘B did not hide the sidebar', 10_000);
        await regionIs('transcript', 'hiding the sidebar did not return focus to the transcript');
        await p.keyboard.press('ControlOrMeta+b');
        await regionIs('sidebar', 'the third ⌘B did not show and focus the sidebar');
        assert.equal(await sidebarHidden(), false);
        return { back: 'transcript' };
      });
      await j.step('sidebar-return', 'Twenty rounds, starting in the transcript or the composer in turn: ⌘B twice returns focus to where it was', async () => {
        for (let round = 1; round <= 20; round++) {
          const start = round % 2 ? 'transcript' : 'composer';
          await focusTranscript();
          if (start === 'composer') { await p.keyboard.press('ControlOrMeta+i'); await regionIs('composer', `round ${round}: ⌘I did not focus the composer`); }
          await p.keyboard.press('ControlOrMeta+b');
          await regionIs('sidebar', `round ${round}: ⌘B did not focus the sidebar`);
          await p.keyboard.press('ControlOrMeta+b');
          await assertEventually(sidebarHidden, `round ${round}: ⌘B did not hide the sidebar`, 10_000);
          await regionIs(start, `round ${round}: hiding the sidebar did not return focus to the ${start}`);
          await p.keyboard.press('ControlOrMeta+b');
          await regionIs('sidebar', `round ${round}: ⌘B did not show the sidebar`);
        }
        return { rounds: 20 };
      });
      await j.step('shell-unavailable', 'In a Pi Session (no shell panel), help names where Toggle shell works, the command palette omits it, and ⌘J opens nothing', async () => {
        await focusTranscript();
        await p.keyboard.press('Shift+Slash');
        const help = p.getByRole('dialog', { name: 'Keys and help' });
        await help.waitFor({ timeout: 10_000 });
        assert.match(await help.innerText(), /Toggle shell · on a Host page/, 'help does not name the context of Toggle shell in a Pi Session');
        await p.keyboard.press('Escape');
        await help.waitFor({ state: 'detached', timeout: 10_000 });
        await p.keyboard.press('ControlOrMeta+Shift+k');
        const palette = p.getByRole('dialog', { name: 'Go to or run' });
        await palette.waitFor({ timeout: 10_000 });
        assert.equal(await palette.locator('.palette-item', { hasText: 'Toggle shell' }).count(), 0, 'the command palette lists Toggle shell in a Pi Session');
        await p.keyboard.press('Escape');
        await palette.waitFor({ state: 'detached', timeout: 10_000 });
        await focusTranscript();
        await p.keyboard.press('ControlOrMeta+j');
        await p.waitForTimeout(300);
        assert.equal(await p.locator('[data-region="panel"]').count(), 0, '⌘J opened a panel in a Pi Session');
        await regionIs('transcript', '⌘J moved focus');
        return { help: 'Toggle shell with context', palette: 'no Toggle shell' };
      });
      await j.step('panel', 'From the transcript press ⌘L twice: open and focus the Arc panel, then close it and return', async () => {
        await focusTranscript();
        await p.keyboard.press('ControlOrMeta+l');
        await regionIs('panel', '⌘L did not open and focus the side panel');
        const tabs = await p.locator('[data-region="panel"]').innerText();
        assert.match(tabs, /Arc/, 'the panel did not open on its default Arc view');
        await p.keyboard.press('ControlOrMeta+l');
        await assertEventually(async () => (await p.locator('[data-region="panel"]').count()) === 0, 'the second ⌘L did not close the panel', 10_000);
        await regionIs('transcript', 'closing the panel did not return focus to the transcript');
        return { opened: 'arc' };
      });
      await j.step('focus-toggle', 'Press ⌘I twice: transcript to composer, composer to transcript', async () => {
        await focusTranscript();
        await p.keyboard.press('ControlOrMeta+i');
        await regionIs('composer', '⌘I did not move focus to the composer');
        assert.equal(await p.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
        await p.keyboard.press('ControlOrMeta+i');
        await regionIs('transcript', '⌘I did not return focus to the transcript');
        return { cycle: ['composer', 'transcript'] };
      });
      await j.step('insert-key', 'In the transcript press i; focus moves to the composer textbox and no i is typed', async () => {
        await focusTranscript();
        await p.keyboard.press('i');
        await regionIs('composer', 'i did not move focus to the composer');
        assert.equal(await p.getByRole('textbox', { name: 'Message the agent' }).inputValue(), '', 'the i reached the composer text');
        return { region: 'composer' };
      });
      await j.step('panel-alias', 'Press ⌘\\ twice from the transcript: the same panel toggle as ⌘L', async () => {
        await focusTranscript();
        await p.keyboard.press('ControlOrMeta+Backslash');
        await regionIs('panel', '⌘\\ did not open and focus the side panel');
        await p.keyboard.press('ControlOrMeta+Backslash');
        await assertEventually(async () => (await p.locator('[data-region="panel"]').count()) === 0, 'the second ⌘\\ did not close the panel', 10_000);
        await regionIs('transcript', 'closing the panel did not return focus to the transcript');
        return { toggled: true };
      });
      await j.step('top-bottom', 'In the transcript press g, then G', async () => {
        await focusTranscript();
        const max = () => p.evaluate(s => { const e = document.querySelector(s); return e.scrollHeight - e.clientHeight; }, transcript);
        // Reaching the top loads older entries, and keep-place then moves scrollTop back to the old first entry,
        // so the proof is the lowest scrollTop seen.
        await p.evaluate(s => { const e = document.querySelector(s); window.__k1Min = e.scrollTop; e.addEventListener('scroll', () => { window.__k1Min = Math.min(window.__k1Min, e.scrollTop); }); }, transcript);
        // Start away from the top, so the lowest scrollTop proves g moved it.
        assert((await scrollOf(transcript)) > 200, `the transcript starts at scrollTop ${await scrollOf(transcript)}, too near the top to prove g`);
        await p.keyboard.press('g');
        await assertEventually(() => p.evaluate(() => window.__k1Min < 50), 'g did not scroll the transcript to the top', 5000);
        await p.keyboard.press('Shift+G');
        await assertEventually(async () => (await max()) - (await scrollOf(transcript)) < 50, 'G did not scroll the transcript to the bottom', 5000);
        return { bottom: await scrollOf(transcript) };
      });
      await j.step('find', 'Press ⌘F; Find in this Session opens with its textbox focused; Escape closes it', async () => {
        await focusTranscript();
        await p.keyboard.press('ControlOrMeta+f');
        const find = p.getByRole('region', { name: 'Find in this Session' });
        await find.waitFor({ timeout: 10_000 });
        assert.equal(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Find in Session');
        await p.keyboard.press('Escape');
        await find.waitFor({ state: 'detached', timeout: 10_000 });
        return { opened: true };
      });
      await j.step('help', 'In the transcript press ?; the help lists the keymap by region; Escape closes it', async () => {
        await focusTranscript();
        await p.keyboard.press('Shift+Slash');
        const help = p.getByRole('dialog', { name: 'Keys and help' });
        await help.waitFor({ timeout: 10_000 });
        const text = await help.innerText();
        for (const label of ['Toggle sidebar', 'Toggle side panel', 'Scroll half page down', 'Increase display size']) assert(text.includes(label), `${label} missing from help`);
        await p.keyboard.press('Escape');
        await help.waitFor({ state: 'detached', timeout: 10_000 });
        return { listed: true };
      });
      await j.step('vim-scroll', 'Press k and u in the transcript, then open the panel and press j and d in it', async () => {
        await focusTranscript();
        const start = await scrollOf(transcript);
        await p.keyboard.press('k');
        await assertEventually(async () => (await scrollOf(transcript)) < start, 'k did not scroll the transcript up', 10_000);
        const afterK = await scrollOf(transcript);
        await p.keyboard.press('u');
        await assertEventually(async () => (await scrollOf(transcript)) < afterK - 100, 'u did not scroll the transcript half a page up', 10_000);
        const afterU = await scrollOf(transcript);
        await p.keyboard.press('ControlOrMeta+l');
        await regionIs('panel', '⌘L did not focus the panel');
        const body = '[data-region="panel"] .panel-body';
        await assertEventually(() => p.evaluate(s => { const e = document.querySelector(s); return Boolean(e && e.scrollHeight > e.clientHeight); }, body), 'the Arc panel has nothing to scroll', 10_000);
        const top = await scrollOf(body);
        await p.keyboard.press('j');
        await assertEventually(async () => (await scrollOf(body)) > top, 'j did not scroll the panel down', 10_000);
        const afterJ = await scrollOf(body);
        await p.keyboard.press('d');
        await assertEventually(async () => (await scrollOf(body)) > afterJ, 'd did not scroll the panel down', 10_000);
        return { transcript: [start, afterK, afterU], panel: [top, afterJ, await scrollOf(body)] };
      });
      await j.step('zoom', 'Press ⌘⇧= twice, ⌘⇧- once, then ⌘⇧0', async () => {
        const seen = [];
        for (const [key, want] of [['ControlOrMeta+Shift+Equal', '1.05'], ['ControlOrMeta+Shift+Equal', '1.1'], ['ControlOrMeta+Shift+Minus', '1.05'], ['ControlOrMeta+Shift+Digit0', '1']]) {
          await p.keyboard.press(key);
          await assertEventually(async () => (await zoom()).html === want, `${key} did not set the display size to ${want}`, 10_000);
          const z = await zoom();
          assert.equal(String(z.stored), want, `${key} did not store the display size`);
          seen.push(z.html);
        }
        return { seen };
      });
      await j.step('command-palette', 'Press ⌘⇧K; the command palette lists the keymap; Escape closes it', async () => {
        await p.keyboard.press('ControlOrMeta+Shift+k');
        const dialog = p.getByRole('dialog', { name: 'Go to or run' });
        await dialog.waitFor({ timeout: 10_000 });
        assert.equal(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Find a command');
        const text = await dialog.innerText();
        for (const label of ['Toggle sidebar', 'Focus composer', 'Jump to a Session']) assert(text.includes(label), `${label} missing from the command palette`);
        await p.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached', timeout: 10_000 });
        return { listed: true };
      });
      await j.step('session-palette', 'Press ⌘K, type a Team name, and press Enter to open its first Session', async () => {
        const before = p.url();
        await p.keyboard.press('ControlOrMeta+k');
        const input = p.getByRole('textbox', { name: 'Find a Session' });
        await input.waitFor({ timeout: 10_000 });
        assert.equal(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Find a Session');
        await input.fill('reader');
        const first = p.locator('.palette-item').first();
        await first.waitFor({ timeout: 10_000 });
        const label = (await first.innerText()).trim();
        assert.match(label, /reader/i, `the first match ${label} does not name the reader Team`);
        await p.keyboard.press('Enter');
        await assertEventually(async () => p.url() !== before && /\/t\//.test(p.url()), 'Enter did not open the matching Session', 5000);
        await input.waitFor({ state: 'detached', timeout: 10_000 });
        return { label, url: p.url().split('#')[1] };
      });
      await j.step('region-zoom', 'Open Display settings from the command palette; raise the transcript size only', async () => {
        await p.keyboard.press('ControlOrMeta+Shift+k');
        await p.getByRole('dialog', { name: 'Go to or run' }).locator('.palette-item', { hasText: 'Display settings' }).click();
        const slider = p.getByRole('slider', { name: 'transcript display size' });
        await slider.waitFor({ timeout: 10_000 });
        await slider.fill('1.2');
        const zooms = () => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-region]')].map(e => [e.getAttribute('data-region'), e.style.zoom || '1'])));
        await assertEventually(async () => (await zooms()).transcript === '1.2', 'the transcript slider did not zoom the transcript', 10_000);
        const z = await zooms();
        assert.equal(z.sidebar, '1', 'the transcript size changed the sidebar');
        assert.equal((await zoom()).html, '1', 'the transcript size changed the overall size');
        await p.keyboard.press('Escape');
        return z;
      });
      await j.step('overview-key', 'Press ⌘0; the Overview opens', async () => {
        await p.locator(transcript).click({ position: { x: 20, y: 20 } });
        await p.keyboard.press('ControlOrMeta+Digit0');
        await p.waitForURL(/#\/v\/overview/, { timeout: 10_000 });
        await assertEventually(() => p.evaluate(() => document.activeElement !== document.body), '⌘0 left focus on BODY', 10_000);
        return { url: p.url().split('#')[1] };
      });
    },
  },
  {
    id: 'K1F', feature: 'k1f-focus.md', title: 'Focus follows the focus model from every region (keymap focus rulings R6–R12)',
    async run(j) {
      const p = j.page;
      // In-page key events only, as in K1. Each step asserts the Region that holds document.activeElement.
      const region = () => p.evaluate(() => document.activeElement?.closest('[data-region]')?.getAttribute('data-region') ?? null);
      const regionIs = async (name, message) => assertEventually(async () => (await region()) === name, `${message}; focus is in ${await region()}`, 10_000);
      const sidebarHidden = () => p.evaluate(() => Boolean(document.querySelector('[data-region="sidebar"]')?.closest('[inert]')));
      const transcript = '[data-region="transcript"]';
      const focusTranscript = async () => { await p.locator(transcript).click({ position: { x: 20, y: 20 } }); await regionIs('transcript', 'a click did not focus the transcript'); };
      await j.step('open', 'Open a long Session from its sidebar row; the transcript and the composer render', async () => {
        await j.goto('#/v/overview');
        await p.locator('.side-scroll .row[data-thread="pi:sess-big"] a.title').click({ timeout: 15_000 });
        await p.waitForURL(/\/t\/pi%3Asess-big/);
        await p.locator(transcript).waitFor({ timeout: 15_000 });
        await p.getByRole('textbox', { name: 'Message the agent' }).waitFor({ timeout: 15_000 });
        await focusTranscript();
        return { session: 'pi:sess-big' };
      });
      // Focus model (focusmodel, TABLE.md §3): every close returns to the region that had focus; focus never rests on BODY.
      const panelCount = () => p.locator('[data-region="panel"]').count();
      const closePanel = async () => {
        if (!(await panelCount())) return;
        if ((await region()) !== 'panel') { await p.keyboard.press('ControlOrMeta+l'); await regionIs('panel', '⌘L did not focus the open panel'); }
        await p.keyboard.press('ControlOrMeta+l');
        await assertEventually(async () => (await panelCount()) === 0, '⌘L did not close the panel', 10_000);
      };
      const startIn = async name => {
        await closePanel();
        if (await sidebarHidden()) await p.keyboard.press('ControlOrMeta+b');
        await focusTranscript();
        if (name === 'composer') await p.keyboard.press('ControlOrMeta+i');
        if (name === 'sidebar') await p.keyboard.press('ControlOrMeta+b');
        if (name === 'panel') await p.keyboard.press('ControlOrMeta+l');
        await regionIs(name, `could not start in the ${name}`);
      };
      await j.step('close-returns', 'From the transcript and the composer: ⌘L twice, then ⌘L and the panel ✕, each return focus to where it was', async () => {
        const seen = [];
        for (const start of ['transcript', 'composer']) {
          await startIn(start);
          await p.keyboard.press('ControlOrMeta+l');
          await regionIs('panel', `from the ${start}, ⌘L did not open and focus the panel`);
          await p.keyboard.press('ControlOrMeta+l');
          await assertEventually(async () => (await panelCount()) === 0, `from the ${start}, the second ⌘L did not close the panel`, 10_000);
          await regionIs(start, `closing the panel with ⌘L did not return focus to the ${start}`);
          await p.keyboard.press('ControlOrMeta+l');
          await regionIs('panel', `from the ${start}, ⌘L did not reopen the panel`);
          await p.locator('[data-region="panel"]').getByTitle('Close panel').click();
          await assertEventually(async () => (await panelCount()) === 0, 'the panel ✕ did not close the panel', 10_000);
          await regionIs(start, `the panel ✕ did not return focus to the ${start}`);
          seen.push(start);
        }
        return { returned: seen };
      });
      await j.step('composer-from-anywhere', 'Press ⌘I from the sidebar and from the panel: focus moves to the composer', async () => {
        for (const start of ['sidebar', 'panel']) {
          await startIn(start);
          await p.keyboard.press('ControlOrMeta+i');
          await regionIs('composer', `⌘I from the ${start} did not focus the composer`);
        }
        await closePanel();
        return { from: ['sidebar', 'panel'] };
      });
      await j.step('find-cancel', 'From the transcript and the composer: ⌘F then Escape returns focus to where it was', async () => {
        const find = p.getByRole('region', { name: 'Find in this Session' });
        for (const start of ['transcript', 'composer']) {
          await startIn(start);
          await p.keyboard.press('ControlOrMeta+f');
          await find.waitFor({ timeout: 10_000 });
          await p.keyboard.press('Escape');
          await find.waitFor({ state: 'detached', timeout: 10_000 });
          await regionIs(start, `cancelling find did not return focus to the ${start}`);
        }
        // R18: Esc on a result link, not only in the input, closes the bar and returns focus.
        await startIn('composer');
        await p.keyboard.press('ControlOrMeta+f');
        await find.getByRole('textbox', { name: 'Find in Session' }).fill('step 570');
        await find.getByRole('textbox', { name: 'Find in Session' }).press('Enter');
        await find.locator('a').first().focus({ timeout: 15_000 });
        await p.keyboard.press('Escape');
        await find.waitFor({ state: 'detached', timeout: 10_000 });
        await regionIs('composer', 'Escape on a find result did not return focus to the composer');
        return { returned: true, fromLink: true };
      });
      await j.step('modal-blocks', 'With the Session palette open: ⌘B does nothing, ⌘⇧K switches palettes and keeps the query, ⌘⇧K again closes', async () => {
        await startIn('transcript');
        const hidden = await sidebarHidden();
        await p.keyboard.press('ControlOrMeta+k');
        const sessions = p.getByRole('textbox', { name: 'Find a Session' });
        await sessions.waitFor({ timeout: 10_000 });
        await sessions.fill('rea');
        await p.keyboard.press('ControlOrMeta+b');
        await p.waitForTimeout(300);
        assert.equal(await sidebarHidden(), hidden, '⌘B changed the sidebar behind the open palette');
        assert.equal(await p.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Find a Session', '⌘B moved focus out of the open palette');
        await p.keyboard.press('ControlOrMeta+Shift+k');
        const commands = p.getByRole('textbox', { name: 'Find a command' });
        await commands.waitFor({ timeout: 10_000 });
        assert.equal(await commands.inputValue(), 'rea', 'switching palettes dropped the typed query');
        await p.keyboard.press('ControlOrMeta+Shift+k');
        await commands.waitFor({ state: 'detached', timeout: 10_000 });
        await regionIs('transcript', 'closing the palette did not return focus to the transcript');
        return { switched: true };
      });
      await j.step('focus-matrix', 'From each start region (sidebar, transcript, composer, panel) press ⌘B, ⌘L and ⌘I; focus lands where TABLE.md says', async () => {
        const expected = {
          'ControlOrMeta+b': { sidebar: 'transcript', transcript: 'sidebar', composer: 'sidebar', panel: 'sidebar' },
          'ControlOrMeta+l': { sidebar: 'panel', transcript: 'panel', composer: 'panel', panel: 'transcript' },
          'ControlOrMeta+i': { sidebar: 'composer', transcript: 'composer', composer: 'transcript', panel: 'composer' },
        };
        const cells = [];
        for (const [key, row] of Object.entries(expected)) for (const [start, want] of Object.entries(row)) {
          await startIn(start);
          await p.keyboard.press(key);
          await regionIs(want, `${key} from the ${start} did not focus the ${want}`);
          cells.push(`${start}+${key.split('+')[1]}=${want}`);
        }
        await closePanel();
        if (await sidebarHidden()) await p.keyboard.press('ControlOrMeta+b');
        return { cells: cells.length };
      });
      await j.step('intent-latency', 'Measure only (no limit): time from a ⌘I keydown to the focusin it causes, 10 presses', async () => {
        await startIn('transcript');
        await p.evaluate(() => {
          window.__lat = [];
          let start = 0;
          document.addEventListener('keydown', () => { start = performance.now(); }, true);
          document.addEventListener('focusin', () => { if (start) { window.__lat.push(performance.now() - start); start = 0; } }, true);
        });
        for (let n = 0; n < 10; n++) {
          await p.keyboard.press('ControlOrMeta+i');
          await regionIs(n % 2 ? 'transcript' : 'composer', `⌘I press ${n + 1} did not toggle`);
        }
        const ms = (await p.evaluate(() => window.__lat)).map(Math.round).sort((x, y) => x - y);
        return { presses: ms.length, medianMs: ms[Math.floor(ms.length / 2)], maxMs: ms.at(-1) };
      });
      await j.step('palette-run', 'With the sidebar focused, run Toggle sidebar from the command palette: the sidebar hides and focus returns to the transcript', async () => {
        await startIn('sidebar');
        await p.keyboard.press('ControlOrMeta+Shift+k');
        const palette = p.getByRole('dialog', { name: 'Go to or run' });
        await palette.waitFor({ timeout: 10_000 });
        await palette.locator('.palette-item', { hasText: 'Toggle sidebar' }).click();
        await assertEventually(sidebarHidden, 'Toggle sidebar from the palette did not hide the focused sidebar', 10_000);
        await regionIs('transcript', 'Toggle sidebar from the palette did not return focus to the transcript');
        await p.keyboard.press('ControlOrMeta+b');
        return { hidden: true };
      });
      await j.step('panel-default', 'Star another panel as the default: ⌘L opens it; a tab switch keeps focus in the panel', async () => {
        await startIn('panel');
        const other = p.locator('[data-region="panel"] .panel-tab-choice > button:first-child:not(.on)').first();
        const name = (await other.innerText()).trim();
        const star = p.locator('[data-region="panel"]').getByRole('button', { name: `Open ${name} by default` });
        await star.click();
        // R17: the star fills at once.
        await assertEventually(async () => (await star.innerText()).trim() === '★', `the ${name} star did not fill after a click`, 10_000);
        await closePanel();
        // R16: the topbar Arc button shows Arc now and never writes the ⌘L default.
        const arcButton = p.locator('.rb-controls > button', { hasText: /^Arc$/ });
        await arcButton.click();
        await assertEventually(async () => (await panelCount()) === 1, 'the Arc button did not show the panel', 10_000);
        await arcButton.click();
        await assertEventually(async () => (await panelCount()) === 0, 'the Arc button did not hide the panel', 10_000);
        // R20: the panel ✕ on Arc counts as the Arc button off, so a wide Session does not reopen Arc.
        await arcButton.click();
        await assertEventually(async () => (await panelCount()) === 1, 'the Arc button did not show the panel', 10_000);
        await p.locator('[data-region="panel"]').getByTitle('Close panel').click();
        await assertEventually(async () => (await panelCount()) === 0, 'the panel ✕ did not close Arc', 10_000);
        assert.equal(await p.evaluate(() => localStorage.getItem('ampi.arc.reopen')), '0', 'the panel ✕ on Arc left Arc set to reopen');
        // R21: ⌘L hide is an explicit close too.
        await arcButton.click();
        await assertEventually(async () => (await panelCount()) === 1, 'the Arc button did not show the panel', 10_000);
        await closePanel();
        assert.equal(await p.evaluate(() => localStorage.getItem('ampi.arc.reopen')), '0', '⌘L hide of Arc left Arc set to reopen');
        await focusTranscript();
        await p.keyboard.press('ControlOrMeta+l');
        await regionIs('panel', '⌘L did not open and focus the panel');
        assert.match(await p.locator('[data-region="panel"] .panel-tab-choice > button.on').innerText(), new RegExp(name), `⌘L did not open the configured default ${name}`);
        await p.locator('[data-region="panel"] .panel-tab-choice > button:first-child', { hasText: 'Arc' }).click();
        await regionIs('panel', 'switching the panel tab dropped focus');
        await p.locator('[data-region="panel"]').getByRole('button', { name: 'Open Arc by default' }).click();
        await closePanel();
        return { defaultOpened: name };
      });
      await j.step('arc-reopen', 'Arc shown last: a wide Session opens with Arc; with Arc open, a narrow pane opens the Session with Arc collapsed (R16)', async () => {
        const reopenSession = async () => {
          await j.goto('#/v/overview');
          await p.locator('.side-scroll .row[data-thread="pi:sess-big"] a.title').click({ timeout: 15_000 });
          await p.waitForURL(/\/t\/pi%3Asess-big/);
          await p.locator(transcript).waitFor({ timeout: 15_000 });
        };
        const shown = () => p.locator('[data-region="panel"] .panel-tab-choice > button.on').innerText().catch(() => '');
        await closePanel();
        await p.evaluate(() => localStorage.setItem('ampi.arc.reopen', '1'));
        await reopenSession();
        await assertEventually(async () => (await panelCount()) === 1 && /Arc/.test(await shown()), 'a wide Session did not reopen Arc after the owner showed it', 10_000);
        // I20: the reopen shows Arc and keeps focus where the Session open put it.
        const afterReopen = await region();
        assert.notEqual(afterReopen, 'panel', 'reopening Arc moved focus into the panel');
        await p.setViewportSize({ width: 1000, height: 960 });
        try {
          await reopenSession();
          // The collapse happens when the Session opens; give a late reopen time to show before reading the panel.
          await p.waitForTimeout(500);
          assert.equal(await panelCount(), 0, 'a narrow pane opened the Session with the saved Arc panel shown');
        } finally {
          await p.setViewportSize({ width: 1440, height: 960 });
          await p.evaluate(() => localStorage.setItem('ampi.arc.reopen', '0'));
        }
        return { wideReopened: true, focusAfterReopen: afterReopen, narrowCollapsed: true };
      });
      await j.step('session-switch', 'Press Alt+↓ in the transcript: the next Session opens with focus in its composer', async () => {
        await startIn('transcript');
        const before = p.url();
        await p.keyboard.press('Alt+ArrowDown');
        await assertEventually(async () => p.url() !== before, 'Alt+↓ did not open another Session', 5000);
        await regionIs('composer', 'the Session switch did not focus the composer');
        await p.keyboard.press('Alt+ArrowUp');
        await assertEventually(async () => p.url() === before, 'Alt+↑ did not return to the Session', 5000);
        await p.locator(transcript).waitFor({ timeout: 15_000 });
        return { switched: true };
      });
      // D20: ⌘0 focuses the Overview content (the marked page scroller), so Space and ↓ scroll it at once.
      const pageContentFocused = () => p.evaluate(() => document.activeElement?.matches('[data-page-root] [data-page-scroller]') ?? false);
      const transcriptTop = () => p.evaluate(() => document.querySelector('[data-region="transcript"]').scrollTop);
      await j.step('history', 'Read mid-transcript with a draft, ⌘0, then Back: the transcript returns at its place with focus and the draft; Forward returns to the Overview content. Browser path (history.back) and AmPi.app path (⌘[ / ⌘])', async () => {
        await startIn('composer');
        const draft = 'draft kept across Back';
        await p.getByRole('textbox', { name: 'Message the agent' }).fill(draft);
        await focusTranscript();
        await p.evaluate(() => { const el = document.querySelector('[data-region="transcript"]'); el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 1500); });
        await p.waitForTimeout(300);
        const session = p.url();
        const top = await transcriptTop();
        const back = async (how) => {
          await how();
          await assertEventually(async () => p.url() === session, `${how.name}: Back did not return to the Session`, 10_000);
          await p.locator(transcript).waitFor({ timeout: 15_000 });
          await regionIs('transcript', `${how.name}: Back did not return focus to the transcript`);
          await assertEventually(async () => Math.abs((await transcriptTop()) - top) <= 40, `${how.name}: Back did not return to the reading place (was ${top}, now ${await transcriptTop()})`, 10_000);
          assert.equal(await p.getByRole('textbox', { name: 'Message the agent' }).inputValue(), draft, `${how.name}: the unsent draft was lost`);
        };
        const forward = async (how) => {
          await how();
          await p.waitForURL(/#\/v\/overview/, { timeout: 10_000 });
          await assertEventually(pageContentFocused, `${how.name}: Forward did not focus the Overview content`, 10_000);
        };
        await p.keyboard.press('ControlOrMeta+Digit0');
        await p.waitForURL(/#\/v\/overview/, { timeout: 10_000 });
        // The browser carrier: AmPi binds no key there; the browser's own Back runs history.back().
        await back(async function browserBack() { await p.evaluate(() => history.back()); });
        await forward(async function browserForward() { await p.evaluate(() => history.forward()); });
        // The AmPi.app carrier (its WKWebView message handler): AmPi's keymap runs Back and Forward.
        await p.evaluate(() => { window.webkit = { messageHandlers: { ampi: { postMessage() {} } } }; });
        try {
          await back(async function appBack() { await p.keyboard.press('ControlOrMeta+BracketLeft'); });
          await forward(async function appForward() { await p.keyboard.press('ControlOrMeta+BracketRight'); });
          await back(async function appBackAgain() { await p.keyboard.press('ControlOrMeta+BracketLeft'); });
        } finally {
          await p.evaluate(() => { delete window.webkit; });
        }
        await p.getByRole('textbox', { name: 'Message the agent' }).fill('');
        // Back to a Session or Host that no longer exists names that state, and Back leaves it again.
        const gone = {};
        for (const [name, swap, text] of [
          ['session', h => h.replace(/\/t\/[^?]+/, '/t/pi%3Agone-session'), /Unknown Session on this Host/],
          ['host', h => h.replace(/^#\/h\/[^/]+/, '#/h/gone-host'), /Unknown host gone-host/],
        ]) {
          await p.evaluate(hash => { location.hash = hash; }, swap(new URL(session).hash));
          await assertEventually(async () => text.test(await p.locator('[data-page-root]').innerText()), `a gone ${name} does not say "${text.source}"; it shows: ${(await p.locator('[data-page-root]').innerText()).trim().slice(0, 160)}`, 15_000);
          gone[name] = (await p.locator('[data-page-root] .empty').first().innerText()).trim();
          await p.evaluate(() => history.back());
          await assertEventually(async () => p.url() === session, `Back from a gone ${name} did not return`, 10_000);
          await p.locator(transcript).waitFor({ timeout: 15_000 });
        }
        return { top, draft: true, gone };
      });
      await j.step('overview', 'Press ⌘0 from the transcript: the Overview opens with its content focused (D20)', async () => {
        await focusTranscript();
        await p.keyboard.press('ControlOrMeta+Digit0');
        await p.waitForURL(/#\/v\/overview/, { timeout: 10_000 });
        await assertEventually(pageContentFocused, `⌘0 from the transcript did not focus the Overview content; focus is in ${await region()}`, 10_000);
        return { url: p.url().split('#')[1] };
      });
      await j.step('page-sidebar', 'On the Overview with the sidebar focused, ⌘B hides it and the page scroller takes focus with a ring and scrolls with ↓; ⌘B again shows and focuses the sidebar', async () => {
        if (await sidebarHidden()) await p.keyboard.press('ControlOrMeta+b');
        if ((await region()) !== 'sidebar') await p.keyboard.press('ControlOrMeta+b');
        await regionIs('sidebar', '⌘B on the Overview did not focus the sidebar');
        await p.keyboard.press('ControlOrMeta+b');
        await assertEventually(sidebarHidden, '⌘B on the Overview did not hide the sidebar', 10_000);
        await assertEventually(() => p.evaluate(() => Boolean(document.activeElement?.closest('[data-page-root]'))), 'hiding the sidebar on the Overview did not focus the page', 10_000);
        // R9: the page target shows a ring in keyboard mode and scrolls with ↓.
        const page = await p.evaluate(() => { const a = document.activeElement; return { ring: getComputedStyle(a).outlineStyle, scrollable: a.scrollHeight > a.clientHeight, top: a.scrollTop }; });
        assert.notEqual(page.ring, 'none', 'the focused page target shows no focus ring');
        if (page.scrollable) {
          await p.keyboard.press('ArrowDown');
          await assertEventually(() => p.evaluate(top => document.activeElement.scrollTop > top, page.top), '↓ did not scroll the focused page', 10_000);
        }
        await p.keyboard.press('ControlOrMeta+b');
        await regionIs('sidebar', '⌘B on the Overview did not show and focus the sidebar');
        return { ring: page.ring, scrollable: page.scrollable };
      });
    },
  },
];

export async function assertEventually(test, message, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await new Promise(done => setTimeout(done, 150)); }
  assert.fail(message);
}

export { arc };
