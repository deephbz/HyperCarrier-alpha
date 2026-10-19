// Deterministic journeys, one per feature file in .pi/skills/verify-ampi/features/.
// Each journey drives the real UI against the synthetic demo hub through user paths. Each step returns the
// observed state; the runner adds a screenshot, an ARIA snapshot, and the hub side effects of that step.
// j.gap(incident, ...) marks a known product gap: it must still fail. If it passes, the journey fails so the
// map gets updated.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { thread, timeline, arc } from '../ux/recipes.mjs';
import { threadsSnapshot, topicSnapshot, paneCoverage, agentWatch } from './live-rows.mjs';
import { app } from './hub.mjs';

const num = text => Number(String(text).replace(/[^\d]/g, ''));
const sideScroll = p => p.locator('.side-scroll');
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
 * cos.timeline row that is waiting and not blocked) has a current Arc head in the threads topic. Steps that assert
 * no model call wait for it, so the startup Builds' calls never fall inside them. One promise per run.
 */
const settled = new WeakMap();
function autoBuildsSettled(state, ms = 30_000) {
  if (!settled.has(state)) settled.set(state, (async () => {
    const auth = { bearer: readFileSync(join(state.run, 'hub.key'), 'utf8').trim() }, deadline = Date.now() + ms;
    for (;;) {
      const timeline = await topicSnapshot({ port: state.port, host: 'devbox', auth, topic: { kind: 'view', view: 'cos.timeline' } });
      const threads = await threadsOf(state), arcs = new Map(threads.map(t => [t.id, t.arc])), derived = new Set(timeline.sessions.map(s => s.threadId));
      // A live idle Session not derived yet may still become eligible; it is pending too.
      const pending = [...threads.filter(t => t.live && t.activity === 'idle' && !derived.has(t.id)).map(t => t.id),
        ...timeline.sessions.filter(s => s.waiting && !s.blocked).map(s => s.threadId).filter(id => !arcs.get(id) || arcs.get(id).stale)];
      if (!pending.length) return;
      if (Date.now() > deadline) assert.fail(`automatic Builds did not settle within ${ms / 1000} s: ${pending.join(', ')}`);
      await new Promise(r => setTimeout(r, 250));
    }
  })());
  return settled.get(state);
}

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

export const journeys = [
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
          const added = addWorker(j.state), at = Date.now();
          const report = await liveSessionsMatch(j.state, at + LIVE_MS);
          return { ...added, ...report, msToJoin: Date.now() - at };
        });
        await j.step('orphan-pane-red', 'Negative control: a Herdr Pi pane without a Session must turn the check red', async () => {
          const path = join(j.state.demo, 'state.json'), herdr = JSON.parse(readFileSync(path, 'utf8'));
          const orphan = { ...herdr.agents.find(a => a.pane_id === 'w1:p9'), pane_id: 'w1:p10', name: 'w1:p10', agent_session: { kind: 'path', agent: 'pi', value: join(j.state.demo, 'missing.jsonl') } };
          writeFileSync(path, JSON.stringify({ ...herdr, agents: [...herdr.agents, orphan] }));
          let error;
          try { await liveSessionsMatch(j.state, Date.now() + 4000, 2000); } catch (e) { error = e.message; }
          writeFileSync(path, JSON.stringify(herdr));
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
      await j.step('sessions-listed', 'Read the sidebar', async () => {
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
          };
        });
        const counted = s => s.rows + s.folded + s.unplacedClosed;
        let seen;
        await assertEventually(async () => { seen = await read(); return seen.rows > 0 && counted(seen) === seen.total; }, 'sidebar does not list every counted Session').catch(() => {});
        assert.equal(counted(seen), seen.total, `sidebar ${seen.rows} rows + ${seen.folded} folded Workers + ${seen.unplacedClosed} in a closed "Not in a pane" ≠ ${seen.total} Sessions`);
        // Expand all Teams: the folded Workers become rows. One click expands only when every Team is collapsed.
        const all = p.locator('[data-host-collapse-all]').first();
        for (let i = 0; i < 2 && await p.locator('[data-collapse-toggle][aria-expanded="false"]').count(); i++) await all.click();
        let open;
        await assertEventually(async () => { open = await read(); return open.folded === 0 && open.rows + open.unplacedClosed === seen.total; }, 'expanded sidebar does not list every counted Session').catch(() => {});
        assert.equal(open.folded, 0, `${open.folded} Workers still folded after Expand all`);
        assert.equal(open.rows + open.unplacedClosed, seen.total, `expanded sidebar ${open.rows} rows + ${open.unplacedClosed} in a closed "Not in a pane" ≠ ${seen.total} Sessions`);
        return { ...seen, expandedRows: open.rows };
      }, { expectSide: s => assert.equal(s.herdrTotal, 0, 'reading AmPi sent a Herdr action'), alone: false });
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
        await p.waitForURL(/#\/v\/arcs\/devbox\//);
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
        const measure = () => side.evaluate(e => ({ top: Math.round(e.scrollTop), max: e.scrollHeight - e.clientHeight }));
        for (let i = 0; i < 20; i++) await p.mouse.wheel(0, 400);
        await assertEventually(async () => { const m = await measure(); return m.max > 0 && m.top >= m.max - 1; }, 'sidebar did not reach its end', 3000).catch(() => {});
        const m = await measure();
        assert(m.max > 0, 'sidebar does not overflow at 540 px');
        assert(m.top >= m.max - 1, `sidebar stopped at ${m.top} of ${m.max}`);
        await p.setViewportSize({ width: 1440, height: 960 });
        return m;
      });
      await j.step('page-keeps-place', 'Add 20 quiet Sessions, then page the Quiet card with Next and Previous', async () => {
        addQuietSessions(j.state);
        // The pager label counts all quiet Sessions; read it only after the hub lists all 20 new ones.
        await assertEventually(async () => (await threadsOf(j.state)).filter(t => t.id.startsWith('pi:sess-verify-quiet-')).length === 20, 'the hub does not list all 20 quiet Sessions', 20_000);
        const card = p.locator('[data-card="quiet"]');
        await card.locator('.list-page').waitFor({ timeout: 20_000 });
        const pager = card.locator('.list-page');
        await pager.scrollIntoViewIfNeeded();
        const place = async () => ({ y: Math.round((await pager.boundingBox()).y), top: Math.round(await p.locator('.main .scroll').evaluate(e => e.scrollTop)), label: await pager.locator('.hint').innerText() });
        const before = await place();
        await pager.getByRole('button', { name: 'Next', exact: true }).click();
        await assertEventually(async () => (await pager.locator('.hint').innerText()) !== before.label, 'Next did not change the page');
        await j.settle();
        const next = await place();
        await pager.getByRole('button', { name: 'Previous', exact: true }).click();
        await assertEventually(async () => (await pager.locator('.hint').innerText()) === before.label, 'Previous did not return');
        await j.settle();
        const back = await place();
        assert.notEqual(next.label, before.label, 'Next did not change the page');
        for (const s of [next, back]) { assert(Math.abs(s.y - before.y) <= 1, `pager moved ${before.y} → ${s.y}`); assert.equal(s.top, before.top); }
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
        await title.click();
        await p.waitForURL(/\/t\/pi%3Asess-big/);
        const shown = await p.getByRole('textbox', { name: 'Thread title' }).inputValue();
        assert(shown.includes(name.slice(0, 20)), `title ${shown} does not match ${name}`);
        return { name, shown };
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
        await band(A21.run).waitFor({ timeout: 20_000 });
        await band(A21.ended).waitFor({ timeout: 5000 });
        const running = await band(A21.run).innerText(), ended = await band(A21.ended).innerText();
        assert(await band(A21.run).locator('.cos-live').count(), `the running band shows no live mark: ${JSON.stringify(running)}`);
        assert.equal(await band(A21.ended).locator('.cos-live').count(), 0, 'the ended band shows a live mark');
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
        await p.waitForURL(/arcs\/devbox\/pi%3Asess-big/);
        await p.getByRole('heading', { level: 1, name: /^Arc · / }).waitFor();
        const toolbar = await p.locator('.cos-toolbar span').first().innerText();
        assert.match(toolbar, /^devbox · (\d+) chunks · [1-9]\d* labelled$/);
        const builds = await p.locator('.cos-builds summary').innerText();
        assert.match(builds, /Arc updated automatically · \d+ calls?/);
        const caption = await p.locator('.cos-caption').first().innerText();
        estimateCalls = num(/· ([\d,]+) calls/.exec(caption)[1]);
        // The estimate names its main cost: synthesis rereads the whole Session on every Build.
        assert.match(caption, /calls · synthesis rereads the whole Session/, `estimate: ${caption}`);
        await p.getByRole('region', { name: 'Chunks over time' }).waitFor();
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
      }, { expectSide: s => assert(s.askCalls >= 1, 'Build arc made no model call') });
      await j.step('arc-panel', 'Open the Session, then choose Arc in its toolbar', async () => {
        await j.goto(thread('big'));
        await p.locator('.composer').waitFor();
        const toggle = p.locator('.rb-controls').getByRole('button', { name: 'Arc', exact: true });
        await toggle.click();
        const panel = p.locator('[data-panel="arc"]');
        await panel.getByRole('link', { name: 'Full Arc page' }).waitFor();
        await panel.getByRole('heading', { level: 2, name: /^Needs you/ }).waitFor();
        assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
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
        return { pressed: true, asks: titles.asks.slice(0, 3), threads: titles.threads.slice(0, 3), leaves: titles.leaves.length };
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
];

export async function assertEventually(test, message, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await new Promise(done => setTimeout(done, 150)); }
  assert.fail(message);
}

export { arc };
