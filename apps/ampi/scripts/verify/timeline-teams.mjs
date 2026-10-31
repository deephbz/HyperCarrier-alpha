// Journey T2teams (features/t2-timeline.md): the Timeline Team toggle renders one group order in both modes.
// Seed incident (2026-10-29, owner): "Separate members" scattered a Team's members over the list, and a closed Worker
// was a solo row. Rule: a Team's lanes are contiguous with the lead first, the group order is the same in both modes, and
// a toggle keeps the group at the top of the viewport at the same offset.
// Lanes are identified by their stream link's thread, and Teams by the demo's Team observation, so a revision without
// the row model fails on the order itself.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { timeline } from '../ux/recipes.mjs';

const ROW = 56;
const HOUR = 3600_000;

/**
 * Team "atlas", all closed (recorded Memberships whose panes are gone), and one closed solo Session, with start times
 * interleaved: worker-1 at -5 h, solo at -4 h, lead at -3 h, worker-2 at -1 h.
 */
export function addClosedTeam(state) {
  const now = Date.now(), dir = join(state.demo, 'agent/sessions/--work-atlas--');
  mkdirSync(dir, { recursive: true });
  const session = (name, startAgo) => {
    const id = `sess-atlas-${name}`, file = join(dir, `atlas-${name}.jsonl`), t0 = now - startAgo, at = ms => new Date(t0 + ms).toISOString();
    const usage = { input: 400, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
    writeFileSync(file, [
      { type: 'session', version: 3, id, timestamp: at(0), cwd: '/work/atlas' },
      { type: 'message', id: `${id}-u`, parentId: null, timestamp: at(1000), message: { role: 'user', content: [{ type: 'text', text: `Atlas ${name}: synthetic work` }], timestamp: t0 + 1000 } },
      { type: 'message', id: `${id}-a`, parentId: `${id}-u`, timestamp: at(40 * 60_000), message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', stopReason: 'stop', usage, timestamp: t0 + 40 * 60_000, content: [{ type: 'text', text: `Atlas ${name} done.` }] } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    return { id, file, name };
  };
  const members = [session('lead', 3 * HOUR), session('worker-1', 5 * HOUR), session('worker-2', 1 * HOUR)];
  const solo = session('solo', 4 * HOUR);
  const path = join(state.demo, 'observation.json'), observation = JSON.parse(readFileSync(path, 'utf8'));
  observation.teams.push({ teamName: 'atlas', issues: [], memberships: members.map((m, i) => ({
    membershipId: `m-atlas-${m.name}`, teamName: 'atlas', memberName: m.name, coordinationRole: i ? 'teammate' : 'lead', lifecycle: { state: 'ended' },
    terminalTarget: { backend: 'herdr', kind: 'pane', targetId: `w9:p${90 + i}` }, session: { kind: 'pi-jsonl-path', locator: m.file }, issues: [],
  })) });
  writeFileSync(path, JSON.stringify(observation));
  return { ids: [...members, solo].map(m => `pi:${m.id}`), lead: `pi:${members[0].id}` };
}

/** Thread → { team, lead } from the demo's Team observation at this moment (other journeys may add Teams). */
function teamTable(state) {
  const table = new Map();
  for (const team of JSON.parse(readFileSync(join(state.demo, 'observation.json'), 'utf8')).teams)
    for (const m of team.memberships) {
      let id;
      try { id = JSON.parse(readFileSync(m.session.locator, 'utf8').split('\n')[0]).id; } catch { continue; }
      table.set(`pi:${id}`, { team: team.teamName, lead: m.coordinationRole === 'lead' });
    }
  return table;
}

/** Every lane in order, through the virtualized list: [index, thread] from each rendered window. */
async function lanes(p) {
  return p.evaluate(async ROW => {
    const box = document.querySelector('.cos-scroll');
    const list = box.querySelector('div[style*="position: relative"]'), out = new Map();
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const total = Math.round(list.getBoundingClientRect().height / ROW);
    for (let top = 0; ; top += ROW * 10) {
      box.scrollTop = top; box.dispatchEvent(new Event('scroll')); await frame();
      const win = list.firstElementChild, first = Math.round(parseFloat(win.style.top) / ROW);
      [...win.children].forEach((row, i) => out.set(first + i, decodeURIComponent(row.querySelector('svg a').getAttribute('href').match(/\/t\/([^?]+)/)[1])));
      if (out.size >= total || top > total * ROW) break;
    }
    box.scrollTop = 0; box.dispatchEvent(new Event('scroll')); await frame();
    return [...out].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }, ROW);
}

/** The lane at the top edge of the scroll box and how many pixels of it are scrolled past. */
async function topLane(p) {
  return p.evaluate(() => {
    const box = document.querySelector('.cos-scroll'), b = box.getBoundingClientRect();
    const row = document.elementsFromPoint(b.left + 40, b.top + 1).map(e => e.closest('.cos-stream-row')).find(Boolean);
    return { thread: decodeURIComponent(row.querySelector('svg a').getAttribute('href').match(/\/t\/([^?]+)/)[1]), px: Math.round(b.top - row.getBoundingClientRect().top) };
  });
}

const groupOf = (table, thread) => table.get(thread)?.team ?? thread;
const dedupe = list => list.filter((g, i) => list.indexOf(g) === i);

/**
 * Other journeys add Sessions and change attention meanwhile, and a new lane above the viewport moves every lane below
 * it. A reading counts only when the separate lane order before and after it agrees, so a fleet change is retried and
 * never read as a toggle failure. `attempt` starts and ends with Team members separated.
 */
async function steady(p, attempt) {
  const tries = [];
  for (let i = 0; i < 5; i++) {
    const before = await lanes(p);
    let result, error;
    try { result = await attempt(before); } catch (e) { error = e; }
    const after = await lanes(p);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      if (error) throw error;
      return { ...result, tries: i + 1 };
    }
    tries.push({ before, after, error: error?.message });
  }
  assert.fail(`the fleet changed during each of ${tries.length} readings: ${JSON.stringify(tries.at(-1))}`);
}

/** `addFixture` is journeys.mjs addFixture: it opens the side-effect gate after the hub lists and derives the Sessions. */
export async function timelineTeams(j, addFixture) {
  const p = j.page;
  const seeded = await addFixture(j, () => addClosedTeam(j.state), r => r.ids);
  await p.setViewportSize({ width: 1280, height: 520 });
  await j.goto(`${timeline}?teams=separate`);
  const toggle = p.getByRole('navigation', { name: 'Timeline controls' }).locator('.cos-team-toggle');
  await j.step('closed-members-listed', 'Open the Timeline with Team members separated; wait for Team atlas and the closed solo Session', async () => {
    const end = Date.now() + 30_000;
    let seen = [];
    while (Date.now() < end && !seeded.ids.every(id => seen.includes(id))) { seen = await lanes(p).catch(() => []); await p.waitForTimeout(250); }
    assert(seeded.ids.every(id => seen.includes(id)), `lanes ${seen.join(', ')} lack ${seeded.ids.join(', ')}`);
    return { lanes: seen.length };
  });
  await j.step('members-in-place', 'Read the separate lanes: each Team is contiguous, lead first, closed Workers included', async () => {
    const table = teamTable(j.state), order = await lanes(p), groups = order.map(t => groupOf(table, t));
    for (const team of new Set(groups.filter(g => order.some(t => table.get(t)?.team === g)))) {
      const at = groups.flatMap((g, i) => g === team ? [i] : []);
      assert.equal(at.at(-1) - at[0] + 1, at.length, `Team ${team} lanes are scattered at rows ${at.join(', ')}: ${order.join(', ')}`);
      const lead = order.find(t => table.get(t)?.team === team && table.get(t).lead);
      if (lead) assert.equal(order[at[0]], lead, `Team ${team} does not start with its lead`);
    }
    const atlas = order.filter(t => table.get(t)?.team === 'atlas');
    assert.deepEqual(atlas, [seeded.lead, 'pi:sess-atlas-worker-1', 'pi:sess-atlas-worker-2'], 'atlas members: lead, then start order');
    return { order, groups: dedupe(groups) };
  });
  await j.step('toggle-label', 'Read the toggle: its label names the current mode', async () => {
    assert.equal((await toggle.textContent())?.trim(), 'Team members separated');
    await toggle.click(); await p.waitForURL(/teams=merged/);
    assert.equal((await toggle.textContent())?.trim(), 'Team members merged');
    await toggle.click(); await p.waitForURL(/teams=separate/);
  });
  await j.step('toggle-keeps-groups', 'Merge Team members; the group order is the separate order with each Team folded to one lane', async () => {
    const table = teamTable(j.state);
    return steady(p, async separate => {
      await toggle.click(); await p.waitForURL(/teams=merged/);
      const order = await lanes(p), merged = order.map(t => groupOf(table, t));
      await toggle.click(); await p.waitForURL(/teams=separate/);
      assert.equal(new Set(merged).size, merged.length, `a Team has more than one merged lane: ${order.join(', ')}`);
      assert.deepEqual(merged, dedupe(separate.map(t => groupOf(table, t))), 'the toggle reordered groups');
      return { merged: order };
    });
  });
  await j.step('place-kept', 'Scroll Team atlas to the top, 10 px into its second lane; toggle twice; atlas stays at the top', async () => {
    const table = teamTable(j.state);
    return steady(p, async order => {
      const index = order.indexOf('pi:sess-atlas-worker-1');
      await p.evaluate(top => { const box = document.querySelector('.cos-scroll'); box.scrollTop = top; box.dispatchEvent(new Event('scroll')); }, index * ROW + 10);
      await j.settle();
      const before = await topLane(p);
      assert.deepEqual([groupOf(table, before.thread), before.px], ['atlas', 10], `scroll setup: ${JSON.stringify(before)}`);
      const max = await p.evaluate(() => { const b = document.querySelector('.cos-scroll'); return b.scrollHeight - b.clientHeight; });
      await toggle.click(); await p.waitForURL(/teams=merged/); await j.settle();
      const merged = await topLane(p);
      await toggle.click(); await p.waitForURL(/teams=separate/); await j.settle();
      const back = await topLane(p);
      // Merged, atlas has one lane: the place clamps to it at the same pixel offset, unless the list cannot scroll that far.
      assert.equal(groupOf(table, merged.thread), 'atlas', `merged top lane ${JSON.stringify(merged)}`);
      assert.equal(groupOf(table, back.thread), 'atlas', `separate top lane ${JSON.stringify(back)}`);
      assert(Math.abs(merged.px - 10) <= 1 && Math.abs(back.px - 10) <= 1, `offsets ${merged.px}, ${back.px}`);
      return { before, merged, back, max };
    });
  });
}
