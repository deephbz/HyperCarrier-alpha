// Measurement instrument. Explicit carrier roots and the canonical PiHost bootstrap determine each role.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { BOOTSTRAP } from "../../src/pi/host.ts";

/**
 * Hub is the root process alone. An argv containing PiHost's bootstrap identifies an agent subtree only below hub.
 * All other hub descendants are helpers. Explicit tool subtrees override agent/node/helper membership.
 * No process name, PID value, encoded-source copy, or environment inspection determines an agent's role.
 */
export function classifyProcesses(processes, { hub, node, tools = [] }) {
  assert.ok(Number.isInteger(hub) && hub > 0 && Number.isInteger(node) && node > 0 && hub !== node);
  const parents = new Map(processes.map(({ pid, ppid }) => [pid, ppid]));
  const below = (pid, root) => {
    const seen = new Set();
    while (pid > 0 && !seen.has(pid)) {
      if (pid === root) return true;
      seen.add(pid);
      pid = parents.get(pid) ?? 0;
    }
    return false;
  };
  for (const root of [hub, node, ...tools]) assert.ok(parents.has(root), `missing root ${root}`);
  assert.ok(!below(hub, node) && !below(node, hub), "hub and node trees overlap");
  for (const root of tools) assert.ok(below(root, hub) || below(root, node), "tool root outside measured trees");
  assert.ok(!tools.includes(hub) && !tools.includes(node), "tool root cannot replace a carrier root");
  const agents = processes.filter(({ pid, command }) =>
    pid !== hub && below(pid, hub) && !tools.some(root => below(pid, root)) && command.includes(BOOTSTRAP)).map(({ pid }) => pid);
  const roles = new Map();
  for (const pid of parents.keys()) {
    if (pid === hub) roles.set(pid, "hub");
    else if (below(pid, hub) || below(pid, node))
      roles.set(pid, tools.some(root => below(pid, root)) ? "tools"
        : below(pid, node) ? "node" : agents.some(root => below(pid, root)) ? "agent" : "helpers");
  }
  return { agents, roles };
}

export function sampleTrees(binary, { hub, node, tools = [] }) {
  const processes = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 })
    .trim().split("\n").map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      assert.ok(match, "invalid process ancestry row");
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
    });
  const { agents, roles } = classifyProcesses(processes, { hub, node, tools });
  const raw = execFileSync("python3", [binary, ...[...roles.keys()].map(String)], { encoding: "utf8", timeout: 2000 });
  const rows = raw.trim().split("\n").map(line => {
    const [pid, bytes, errno] = line.split(" ").map(Number);
    return { pid, role: roles.get(pid), bytes, errno };
  });
  assert.equal(rows.length, roles.size);
  assert.equal(new Set(rows.map(row => row.pid)).size, roles.size);
  assert.ok(rows.every(row => row.role && row.errno === 0 && row.bytes > 0), "partial phys_footprint sample");
  return {
    atMs: performance.now(), roots: { hub, agents, node, tools },
    totals: Object.fromEntries(["hub", "agent", "node", "helpers", "tools"].map(role =>
      [role, rows.filter(row => row.role === role).reduce((sum, row) => sum + row.bytes, 0)])),
    rows,
  };
}

export function slopeBytesPerHour(samples, role) {
  assert.ok(samples.length >= 2);
  const origin = samples[0].atMs;
  const x = samples.map(s => (s.atMs - origin) / 3_600_000);
  const y = samples.map(s => s.totals[role]);
  const mx = x.reduce((a, b) => a + b) / x.length;
  const my = y.reduce((a, b) => a + b) / y.length;
  const variance = x.reduce((a, b) => a + (b - mx) ** 2, 0);
  assert.ok(variance > 0);
  return x.reduce((sum, v, i) => sum + (v - mx) * (y[i] - my), 0) / variance;
}
