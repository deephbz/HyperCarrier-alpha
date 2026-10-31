// A synthetic long Pi Session for the message-navigation journeys (features/t3nav-reveal-message.md).
// Deterministic: the same options give byte-identical files. Everything is synthetic; nothing reads real logs.
//
// Shape, per turn: owner message, assistant (thinking, text, tool call), tool result, assistant answer. Every
// `clipEvery`-th tool result is longer than the preview bound, so its body is clipped. Every `compactEvery` turns a
// compaction follows. At `branchAt` an abandoned branch of `branchTurns` turns forks off, and the active branch
// continues from the fork point, so the abandoned entries exist in the file but not on the current branch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const L = value => JSON.stringify(value) + '\n';

/**
 * Writes `<dir>/<name>.jsonl` and returns the Session id, file and named target entries. Targets name entries at the
 * start, middle and end of the active branch, a clipped tool result, a compaction, and an abandoned-branch entry.
 */
export function writeNavLongSession(dir, { name = 'nav-long', turns = 7500, compactEvery = 500, clipEvery = 10, branchAt = 7000, branchTurns = 3, now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const id = `sess-${name}`;
  const file = join(dir, `${name}.jsonl`);
  let t = now - turns * 60_000;
  const iso = () => new Date(t).toISOString();
  const usage = { input: 1200, output: 300, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.002 } };
  const parts = [L({ type: 'session', version: 3, id, timestamp: iso(), cwd: '/work/nav-long' })];
  const users = [], compactions = [], clipped = [], abandoned = [];
  let parent = null, entries = 0;
  const push = row => { parts.push(L(row)); entries++; return row.id; };
  const turn = (i, prefix) => {
    const u = `${prefix}u${i}`, a = `${prefix}a${i}`, r = `${prefix}r${i}`, b = `${prefix}b${i}`, call = `${prefix}c${i}`;
    push({ type: 'message', id: u, parentId: parent, timestamp: iso(), message: { role: 'user', content: [{ type: 'text', text: `Nav turn ${i}${prefix ? ' (abandoned branch)' : ''}: check step ${i} and report.` }], timestamp: t } });
    t += 10_000;
    push({ type: 'message', id: a, parentId: u, timestamp: iso(), message: { role: 'assistant', model: 'claude-opus-5-5', provider: 'anthropic', stopReason: 'toolUse', usage,
      content: [{ type: 'thinking', thinking: `Plan for step ${i}.` }, { type: 'text', text: `Looking at step ${i}.` }, { type: 'toolCall', id: call, name: 'bash', arguments: { command: `run-step ${i}` } }] } });
    t += 10_000;
    const long = i % clipEvery === 0;
    push({ type: 'message', id: r, parentId: a, timestamp: iso(), message: { role: 'toolResult', toolCallId: call, toolName: 'bash',
      content: [{ type: 'text', text: long ? `step ${i} output\n` + 'x'.repeat(64) .concat('\n').repeat(400) : `step ${i} ok` }], isError: false } });
    t += 10_000;
    push({ type: 'message', id: b, parentId: r, timestamp: iso(), message: { role: 'assistant', model: 'claude-opus-5-5', provider: 'anthropic', stopReason: 'stop', usage, content: [{ type: 'text', text: `Step ${i} done.` }] } });
    t += 30_000;
    return { u, a, r, b, long };
  };
  for (let i = 0; i < turns; i++) {
    if (i === branchAt) {
      const fork = parent;
      for (let k = 0; k < branchTurns; k++) { const ids = turn(i + k, 'x'); abandoned.push(ids.u, ids.b); parent = ids.b; }
      parent = fork;
    }
    const ids = turn(i, '');
    users.push(ids.u);
    if (ids.long) clipped.push(ids.r);
    parent = ids.b;
    if ((i + 1) % compactEvery === 0 && i + 1 < turns) {
      const c = `k${i}`;
      t += 5_000;
      push({ type: 'compaction', id: c, parentId: parent, timestamp: iso(), summary: `## Goal\nNavigate.\n\n## Progress\nSteps 0–${i} done.`, firstKeptEntryId: parent, tokensBefore: 180_000 });
      compactions.push(c);
      parent = c;
    }
  }
  writeFileSync(file, parts.join(''));
  const at = f => users[Math.min(users.length - 1, Math.floor(users.length * f))];
  return {
    id, file, entries, turns,
    targets: {
      first: users[0], early: at(0.02), middle: at(0.5), late: at(0.97), last: users.at(-1),
      clippedMiddle: clipped[Math.floor(clipped.length / 2)], compaction: compactions[Math.floor(compactions.length / 2)],
      abandoned: abandoned[0],
    },
  };
}
