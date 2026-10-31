// T3nav: every navigation that names one message lands on it, marks it, and stays fast on a long Session.
// Each step clicks a real source (Find, a scrollbar mark, Rarebit ↗, a Rarebit panel link, an Arc chunk, a Timeline
// stream, a citation) or opens a pasted link, then observes the transcript: the target is in the viewport and carries
// the flash. The long Session is synthetic and lives only in the disposable demo dir (nav-long-session.mjs).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { topicSnapshot } from './live-rows.mjs';
import { keyOf } from './hub.mjs';
import { writeNavLongSession } from './nav-long-session.mjs';
import { href } from '../../web/src/util.ts';
import { arc } from '../ux/recipes.mjs';

const TURNS = Number(process.env.AMPI_NAV_TURNS) || 7500;
const REVEAL_MS = 8000;
// The settle window of a reveal (ThreadView SETTLE_MS) and the budget for a settled-index reveal at p90.
const SETTLE_MS = 1500;
const P90_BUDGET_MS = 1000;
const COLD_MS = 60_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const entryOf = url => new URLSearchParams(new URL(url).hash.split('?')[1] ?? '').get('e');
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };

/** Waits until the target (or the tool-result part that renders it) is inside the transcript viewport and flashes. */
function observe(p, id, budget = REVEAL_MS) {
  return p.evaluate(([id, budget]) => new Promise(done => {
    const t0 = performance.now();
    const tick = () => {
      const sc = document.querySelector('[data-region="transcript"]');
      const els = sc ? [...sc.querySelectorAll(`[data-entry="${CSS.escape(id)}"], [data-result-entry="${CSS.escape(id)}"]`)].filter(el => !el.closest('summary')) : [];
      const box = sc?.getBoundingClientRect();
      const inView = els.some(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > box.top && r.top < box.bottom; });
      const flashed = document.querySelector('[data-region="transcript"] .flash');
      const hit = Boolean(flashed && (flashed.dataset.entry === id || flashed.dataset.resultEntry === id));
      const ms = Math.round(performance.now() - t0);
      const notice = document.querySelector('.entry-missing:not([data-history-cue])');
      // A notice that names a final cause ends the wait; "not indexed yet" resolves on its own.
      if ((inView && hit) || ms > budget || (notice && notice.dataset.why !== 'indexing')) {
        // A tool result is readable only with its call open and its body on screen.
        const body = sc?.querySelector(`[data-result-entry="${CSS.escape(id)}"] .tool-body`)?.getBoundingClientRect();
        const bodyInView = body ? body.height > 0 && body.bottom > box.top && body.top < box.bottom : null;
        done({ ms, ok: inView && hit, inView, bodyInView, flashed: flashed?.dataset.entry ?? flashed?.dataset.resultEntry ?? null, why: notice?.dataset.why ?? null, notice: notice?.textContent ?? null });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), [id, budget]);
}

export async function navAnchors(j) {
  const p = j.page;
  const proof = join(j.state.proof, 'T3nav');
  mkdirSync(proof, { recursive: true });
  await p.setViewportSize({ width: 1440, height: 960 });
  const receipt = { prediction: 'Every source lands on its exact target within the viewport and flashes it; an off-branch target names the cause.', turns: TURNS, rows: [] };
  const save = () => writeFileSync(join(proof, 'nav-anchors.json'), JSON.stringify(receipt, null, 2) + '\n');
  const failures = [];
  const s = writeNavLongSession(join(j.state.demo, 'agent/sessions/--work-nav-long--'), { turns: TURNS });
  receipt.entries = s.entries;
  const thread = `pi:${s.id}`;
  const link = (entry, panel) => href.thread('devbox', thread, { entry, ...(panel ? { panel } : {}) });
  const transcript = p.locator('[data-region="transcript"]');
  const toEnd = () => transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const clearFlash = () => p.evaluate(() => document.querySelectorAll('.flash').forEach(el => el.classList.remove('flash')));

  /**
   * One source: `prepare` reaches it, `trigger` clicks it, the target comes from the resulting URL unless `expect`
   * names it, and the reveal is observed. A failure is recorded and the journey goes on, so one run reports every source.
   */
  const source = async (name, action, trigger, { expect, budget, check, prepare } = {}) => {
    try {
      await j.step(name, action, async () => {
        await prepare?.();
        await clearFlash();
        const t0 = Date.now();
        const before = p.url();
        await trigger();
        if (!expect) await p.waitForURL(url => url.href !== before && Boolean(entryOf(url.href)), { timeout: 10_000 });
        const id = expect ?? entryOf(p.url());
        const r = await observe(p, id, budget);
        const row = { name, id, wallMs: Date.now() - t0, ...r };
        receipt.rows.push(row); save();
        if (check) await check(row);
        else assert.ok(r.ok, `${name}: ${id} not revealed (inView ${r.inView}, flashed ${r.flashed}, notice ${r.notice})`);
        return row;
      });
    } catch (error) { failures.push(`${name}: ${error.message.split('\n')[0]}`); }
  };

  // Cold index: open a pasted link to the middle with the Rarebit panel as soon as the tail is served. The transcript and
  // the panel say the entry is not indexed yet (never "not on the branch"), then both reveal it without another click.
  await j.goto('#/v/overview');
  const auth = { bearer: keyOf(j.state) };
  const seeded = Date.now();
  for (;;) {
    const snap = await topicSnapshot({ port: j.state.port, host: 'devbox', auth, topic: { kind: 'thread', threadId: thread }, timeoutMs: 20_000 }).catch(() => undefined);
    if (snap?.entries?.length) break;
    assert.ok(Date.now() - seeded < 180_000, 'the long Session was not listed within 180 s');
    await sleep(500);
  }
  receipt.tailMs = Date.now() - seeded;
  const seen = new Set();
  const watch = setInterval(() => void p.evaluate(() => [...document.querySelectorAll('.entry-missing[data-why], .rb-state[data-why]')].map(n => `${n.className.split(' ')[0]}:${n.dataset.why}`)).then(xs => xs.forEach(x => seen.add(x)), () => {}), 100);
  await source('cold-index', 'Open a pasted link to the middle message, with the Rarebit panel, while the Session still indexes', async () => {
    await j.goto(link(s.targets.middle, 'rarebit'));
  }, {
    expect: s.targets.middle, budget: COLD_MS,
    check: async r => {
      assert.ok(r.ok, `cold-index: transcript did not reveal ${s.targets.middle} (notice ${r.notice})`);
      await p.locator(`[data-rarebit="${s.targets.middle}"].rb-target`).waitFor({ timeout: COLD_MS });
      clearInterval(watch);
      receipt.coldNotices = [...seen];
      assert.ok(!seen.has('entry-missing:branch') && !seen.has('rb-state:missing'), `cold index was reported as off-branch: ${[...seen]}`);
    },
  });
  clearInterval(watch);
  // Later steps measure the settled index: wait until the thread version stops moving.
  for (let prev; ;) {
    const snap = await topicSnapshot({ port: j.state.port, host: 'devbox', auth, topic: { kind: 'thread', threadId: thread }, timeoutMs: 20_000 });
    if (snap.sourceVersion === prev) break;
    prev = snap.sourceVersion; await sleep(2500);
  }
  receipt.settledMs = Date.now() - seeded;

  for (const key of ['first', 'last', 'compaction']) {
    await source(`link-${key}`, `Open a pasted link to the ${key} target`, () => j.goto(link(s.targets[key])), { expect: s.targets[key] });
  }
  await source('link-clippedMiddle', 'Open a pasted link to a clipped tool result; its call is open and its body on screen', () => j.goto(link(s.targets.clippedMiddle)), {
    expect: s.targets.clippedMiddle,
    check: r => assert.ok(r.ok && r.bodyInView, `clipped result: revealed ${r.ok}, body in view ${r.bodyInView}`),
  });
  // The reader takes over after a reveal: keys scroll up and stay there (no settle or follow pulls them back).
  try {
    await j.step('keys-after-reveal', 'After the reveal, press PageUp three times; the transcript stays where the keys left it', async () => {
      const top = () => transcript.evaluate(el => el.scrollTop);
      await transcript.focus();
      const start = await top();
      for (let i = 0; i < 3; i++) await p.keyboard.press('PageUp');
      // Chromium animates a key scroll: read the place once it holds still for 300 ms.
      let moved = await top();
      for (let still = 0; still < 6;) { await p.waitForTimeout(50); const now = await top(); still = now === moved ? still + 1 : 0; moved = now; }
      await p.waitForTimeout(SETTLE_MS);
      const after = await top();
      receipt.keys = { start, moved, after };
      assert.ok(moved < start - 100, `PageUp did not scroll up: ${start} -> ${moved}`);
      assert.ok(Math.abs(after - moved) <= 2, `the transcript moved by itself after the keys: ${moved} -> ${after}`);
      return receipt.keys;
    });
  } catch (error) { failures.push(`keys-after-reveal: ${error.message.split('\n')[0]}`); }
  // Two links in quick succession: only the second lands and stays after its settle window.
  await source('link-rapid', 'Open a link to an early message, then at once a link to a late one', async () => {
    await j.goto(link(s.targets.early));
    await j.goto(link(s.targets.late));
  }, {
    expect: s.targets.late,
    check: async r => {
      assert.ok(r.ok, `rapid: ${s.targets.late} not revealed (flashed ${r.flashed})`);
      await p.waitForTimeout(SETTLE_MS);
      const still = await observe(p, s.targets.late, 0);
      assert.ok(still.inView, `rapid: ${s.targets.late} left the view after the settle window`);
    },
  });
  await source('link-abandoned', 'Open a pasted link to an abandoned-branch message; read why it is not shown', () => j.goto(link(s.targets.abandoned)), {
    expect: s.targets.abandoned,
    check: r => assert.equal(r.why, 'branch', `abandoned target: notice ${r.why} "${r.notice}"`),
  });

  await source('find', 'Press ⌘F, find the middle turn, click the result', async () => {
    await toEnd();
    await p.keyboard.press('ControlOrMeta+f');
    const find = p.getByRole('region', { name: 'Find in this Session' });
    const input = find.getByRole('textbox', { name: 'Find in Session' });
    await input.fill(`Nav turn ${TURNS / 2}:`);
    await input.press('Enter');
    await find.locator('a').first().click({ timeout: 20_000 });
  });

  // On a long Session the rail shows a sample of the dashes; the pointer clicks the middle shown dash.
  await source('scrollbar-mark', 'Click the transcript scrollbar at a user mark in its middle', async () => {
    const marks = p.locator('.companion-scrollbar:not([aria-busy="true"]) [data-user-mark]:not(.skip)');
    await marks.first().waitFor({ state: 'attached', timeout: 10_000 });
    const box = await marks.nth(Math.floor(await marks.count() / 2)).boundingBox();
    await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }, { prepare: toEnd });

  // Rarebit ↗ opens the panel at the message; the panel shows that exact item, marked.
  for (const [label, id] of [['late', s.targets.late], ['middle', s.targets.middle], ['early', s.targets.early]]) {
    try {
      await j.step(`rarebit-jump-${label}`, `Click Rarebit ↗ on the ${label} message; read the panel`, async () => {
        await j.goto(link(id));
        await observe(p, id);
        const t0 = Date.now();
        await p.locator(`[data-entry="${id}"] .rb-jump`).first().click({ force: true });
        const item = p.locator(`[data-rarebit="${id}"].rb-target`);
        await item.waitFor({ timeout: REVEAL_MS });
        const inView = await item.evaluate(el => { const r = el.getBoundingClientRect(), b = el.closest('.panel-body, [class*=scroll]')?.getBoundingClientRect(); return Boolean(b && r.bottom > b.top && r.top < b.bottom); });
        // The transcript beside the panel still shows the message.
        const transcriptKeeps = await transcript.evaluate((sc, id) => { const el = sc.querySelector(`[data-entry="${CSS.escape(id)}"]`), b = sc.getBoundingClientRect(), r = el?.getBoundingClientRect(); return Boolean(r && r.bottom > b.top && r.top < b.bottom); }, id);
        const row = { name: `rarebit-jump-${label}`, id, wallMs: Date.now() - t0, ok: inView && transcriptKeeps, transcriptKeeps };
        receipt.rows.push(row); save();
        assert.ok(inView, `the panel item ${id} is not in view`);
        assert.ok(transcriptKeeps, `the transcript lost ${id} when the panel opened`);
        return row;
      });
    } catch (error) { failures.push(`rarebit-jump-${label}: ${error.message.split('\n')[0]}`); }
  }
  // The panel's Transcript icon names the route already shown; each click reveals again (repeated target).
  for (const n of [1, 2]) {
    await source(`panel-transcript-${n}`, `Scroll the transcript away, then click the panel item's Transcript icon (click ${n})`, async () => {
      await p.locator(`[data-rarebit="${s.targets.early}"] a[aria-label="Transcript"]`).click();
    }, { expect: s.targets.early, prepare: toEnd });
  }
  // A compaction row in the panel links to the compaction.
  const nearCompaction = `u${Number(s.targets.compaction.slice(1)) - 9}`;
  await source('panel-compaction', 'Open the panel just before a compaction, then click the compaction row', async () => {
    await p.locator(`[data-rarebit="${s.targets.compaction}"] a`).first().click({ timeout: REVEAL_MS });
  }, {
    expect: s.targets.compaction,
    prepare: async () => {
      await j.goto(link(nearCompaction));
      await observe(p, nearCompaction);
      await p.locator(`[data-entry="${nearCompaction}"] .rb-jump`).first().click({ force: true });
      await p.locator(`[data-rarebit="${s.targets.compaction}"]`).waitFor({ timeout: REVEAL_MS });
      await toEnd();
    },
  });

  await source('arc-chunk', 'Open the long Session Arc and click a middle chunk start', async () => {
    await j.goto(`#/v/arcs/devbox/${encodeURIComponent(thread)}`);
    const starts = p.locator('a.cos-chunk-start');
    await starts.first().waitFor({ timeout: 60_000 });
    await starts.nth(Math.floor(await starts.count() / 2)).click();
  });

  await source('timeline', 'Open Timeline and click the long Session stream at its middle', async () => {
    await j.goto('#/v/timeline');
    const stream = p.locator(`svg a[aria-label$=" at nearest entry"][href*="${encodeURIComponent(s.id)}"]`).first();
    await stream.waitFor({ timeout: 20_000 });
    const box = await stream.boundingBox();
    await p.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  });

  await source('citation', 'Open the big Session Arc and click a Work tree citation', async () => {
    await j.goto(arc);
    const tree = p.getByRole('region', { name: 'Evergreen context' });
    const cites = tree.getByRole('link', { name: /^\[#/ });
    await cites.first().waitFor({ timeout: 30_000 });
    await cites.nth(Math.floor(await cites.count() / 2)).click();
  });

  const timed = receipt.rows.filter(r => r.ok && r.name !== 'cold-index').map(r => r.wallMs);
  receipt.wallMs = { n: timed.length, p50: pct(timed, 0.5), p90: pct(timed, 0.9), max: Math.max(...timed) };
  receipt.failures = failures;
  save();
  await j.step('summary', 'Read the reveal times over all sources', async () => {
    assert.deepEqual(failures, [], `sources that did not reveal: ${failures.join('; ')}`);
    // One sample per source on one run: a budget for the slow tail, not a latency distribution.
    assert.ok(receipt.wallMs.p90 <= P90_BUDGET_MS, `reveal p90 ${receipt.wallMs.p90} ms over ${P90_BUDGET_MS} ms`);
    return receipt.wallMs;
  });
}
