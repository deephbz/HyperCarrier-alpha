import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const uuid = (n: string) =>
  `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const session = (id: string, at: string) =>
  `${JSON.stringify({ type: "session", id })}\n${JSON.stringify({ timestamp: at, message: { role: "user", content: "safe" } })}\n`;

test("scoped HTTP capabilities reject malformed, stale, and cross-scope refs without killing the server", async () => {
  const root = await mkdtemp(join(tmpdir(), "traffic-http-"));
  const sessions = join(root, "sessions"),
    teams = join(root, "teams");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(teams, "one"), { recursive: true });
  await mkdir(join(teams, "two"), { recursive: true });
  const a = join(sessions, "a.jsonl"),
    b = join(sessions, "b.jsonl");
  await writeFile(a, session(uuid("1"), "2026-07-15T00:00:00Z"));
  await writeFile(b, session(uuid("2"), "2026-07-15T01:00:00Z"));
  await writeFile(
    join(teams, "one", "config.json"),
    JSON.stringify({ name: "one", members: [{ sessionFile: a }] }),
  );
  await writeFile(
    join(teams, "two", "config.json"),
    JSON.stringify({ name: "two", members: [{ sessionFile: b }] }),
  );
  const port = 4597;
  const child = spawn(
    process.execPath,
    [new URL("../server/index.js", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PI_TRAFFIC_PORT: String(port),
        PI_TRAFFIC_TEAMS_ROOT: teams,
        PI_TRAFFIC_SESSION_ROOTS: JSON.stringify([sessions]),
      },
      stdio: "ignore",
    },
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 30; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {}
      await wait(50);
    }
    const open = async (team: string) =>
      (await (
        await fetch(`${base}/api/traffic/scopes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            selection: { kind: "team_trace", teamRef: `piteams:${team}` },
          }),
        })
      ).json()) as { scope: { scopeRef: string } };
    const [openedOne, openedTwo] = await Promise.all([
      open("one"),
      open("two"),
    ]);
    const one = openedOne.scope.scopeRef;
    const two = openedTwo.scope.scopeRef;
    assert.equal(JSON.stringify(openedOne).includes(root), false);
    const scopeGet = await (
      await fetch(`${base}/api/traffic/scopes/${encodeURIComponent(one)}`)
    ).text();
    assert.equal(
      scopeGet.includes(root),
      false,
      "scope GET never serializes locators",
    );
    const matrix = await (
      await fetch(
        `${base}/api/traffic/scopes/${encodeURIComponent(one)}/matrix`,
      )
    ).json();
    const snapshot = matrix.snapshot.id as string;
    const ordinal = await (
      await fetch(
        `${base}/api/traffic/scopes/${encodeURIComponent(one)}/ordinal`,
      )
    ).json();
    const ordinalText = JSON.stringify(ordinal);
    assert.equal(
      ordinalText.includes(root),
      false,
      "scoped ordinal never serializes adapter locators",
    );
    assert.deepEqual(Object.keys(ordinal.snapshot.provenance).sort(), [
      "classifier",
      "contentPolicy",
      "parserVersion",
      "sourceIds",
      "toolManifestVersion",
    ]);
    const cases = [
      [
        `/api/traffic/scopes/${encodeURIComponent(one)}/secondary?snapshotId=${encodeURIComponent(snapshot)}`,
        200,
      ],
      [
        `/api/traffic/scopes/${encodeURIComponent(two)}/secondary?snapshotId=${encodeURIComponent(snapshot)}`,
        409,
      ],
      [
        `/api/traffic/scopes/${encodeURIComponent(one)}/matrix/events/nope?snapshotId=${encodeURIComponent(snapshot)}`,
        404,
      ],
      [
        `/api/traffic/scopes/${encodeURIComponent(one)}/ordinal/disclosures/nope?snapshotId=${encodeURIComponent(snapshot)}`,
        409,
      ],
      [`/api/traffic/scopes/not%3Aa%20scope/matrix`, 400],
    ] as const;
    for (const [path, expected] of cases)
      assert.equal((await fetch(`${base}${path}`)).status, expected, path);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    child.kill();
  }
});
