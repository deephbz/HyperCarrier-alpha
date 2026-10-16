import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const launcher = join(root, "tools/herdr-node/launch.sh");
const plugins = ["pi-teams-hierarchy", "agent-view-presets", "rarebit-status"];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "hc-node-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, "config");
  mkdirSync(config);
  const probe = join(home, "probe.mjs");
  writeFileSync(probe, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(23);\n");
  function node(relative, version = "v22.19.0") {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then printf '%s\\n' ${quote(version)}; exit; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    return path;
  }
  function run(env = {}, args = [probe, "space argument", "--flag"], cwd = root, script = launcher) {
    return spawnSync("/usr/bin/env", ["-i", `HOME=${home}`, "PATH=/usr/bin:/bin", "SHELL=/bin/false", "HERDR_PLUGIN_ID=test-plugin", `HERDR_PLUGIN_CONFIG_DIR=${config}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/bin/sh", script, ...args], { cwd, encoding: "utf8", timeout: 5000 });
  }
  return { home, config, probe, node, run };
}

function launched(result, path) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, '["space argument","--flag"]');
  assert.ok(result.stderr.includes(`${path} v22.19.0`), result.stderr);
  assert.equal(result.stderr.trim().split("\n").length, 1);
}

test("config file beats HERDR_NODE and changes without restarting the environment", (t) => {
  const f = fixture(t);
  const first = f.node("first node");
  const second = f.node("second node");
  writeFileSync(join(f.config, "node-path"), first); // No final newline is valid.
  launched(f.run({ HERDR_NODE: second }), first);
  writeFileSync(join(f.config, "node-path"), `${second}\n`);
  launched(f.run({ HERDR_NODE: first }), second);
});

test("HERDR_NODE works under env -i and preserves argv and exit status", (t) => {
  const f = fixture(t);
  const node = f.node("explicit node");
  launched(f.run({ HERDR_NODE: node }), node);
});

test("an invalid explicit runtime fails closed with one actionable line and exit 127", (t) => {
  const f = fixture(t);
  const result = f.run({ HERDR_NODE: join(f.home, "missing") });
  assert.equal(result.status, 127);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Herdr plugin test-plugin: node not found;.*HERDR_NODE.*node-path/);
  assert.ok(result.stderr.includes(join(f.config, "node-path")), result.stderr);
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("too-old configured Node fails before running the script", (t) => {
  const f = fixture(t);
  const result = f.run({ HERDR_NODE: f.node("old", "v20.20.0") });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /old v20\.20\.0\n.*Node major 22 or newer required/);
  assert.ok(result.stderr.includes(join(f.config, "node-path")), result.stderr);
});

const systemNode = ["/usr/bin/node", "/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"].some(existsSync);
test("fixed fnm default works without PATH or login shell setup", { skip: systemNode && "host has an earlier system Node candidate" }, (t) => {
  const f = fixture(t);
  const node = f.node(".local/share/fnm/aliases/default/bin/node");
  launched(f.run(), node);
});

test("a too-old fixed candidate stops resolution before a newer candidate", { skip: systemNode && "host has an earlier system Node candidate" }, (t) => {
  const f = fixture(t);
  const old = f.node(".local/share/fnm/aliases/default/bin/node", "v20.20.0");
  const newer = f.node(".volta/bin/node");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.includes(`${old} v20.20.0`), result.stderr);
  assert.match(result.stderr, /Node major 22 or newer required/);
  assert.equal(result.stderr.includes(newer), false);
});

test("nvm resolves the default LTS alias file instead of executing it", { skip: systemNode && "host has an earlier system Node candidate" }, (t) => {
  const f = fixture(t);
  const node = f.node(".nvm/versions/node/v22.19.0/bin/node");
  mkdirSync(join(f.home, ".nvm/alias/lts"), { recursive: true });
  writeFileSync(join(f.home, ".nvm/alias/default"), "lts/*\n");
  writeFileSync(join(f.home, ".nvm/alias/lts/current"), "v22.19.0\n");
  writeFileSync(join(f.home, ".nvm/alias/lts/older"), "v18.0.0\n");
  launched(f.run(), node);
});

test("missing runtime without explicit config exits 127", { skip: systemNode && "host has a system Node candidate" }, (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Herdr plugin test-plugin: node not found;.*HERDR_NODE.*node-path/);
  assert.ok(result.stderr.includes(join(f.config, "node-path")), result.stderr);
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("login shell runs last and never runs when a cheaper candidate succeeds", (t) => {
  const f = fixture(t);
  const marker = join(f.home, "login-called");
  const node = f.node("explicit");
  const shell = join(f.home, "shell");
  writeFileSync(shell, `#!/bin/sh\nprintf called > ${quote(marker)}\nprintf '%s\\n' ${quote(node)}\n`, { mode: 0o755 });
  launched(f.run({ HERDR_NODE: node, SHELL: shell }), node);
  assert.equal(existsSync(marker), false);
  if (!systemNode) {
    launched(f.run({ SHELL: shell }), node);
    assert.equal(readFileSync(marker, "utf8"), "called");
  }
});

const exportManifest = join(root, "release/public/export-manifest.json");
test("all manifest argv arrays work from linked roots and the selected Alpha layout", {
  skip: !existsSync(exportManifest) && "source-only export manifest is absent from the Alpha projection",
}, (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(exportManifest, "utf8"));
  const entries = manifest.entries;
  assert.ok(Array.isArray(entries), "export selection must expose files");
  const exported = join(f.home, "alpha");
  for (const relative of ["tools/herdr-node/launch.sh", "tools/herdr-node/launch.test.mjs", "tools/herdr-node/README.md", ...plugins.map((p) => `tools/${p}/herdr-plugin.toml`)]) {
    const entry = entries.find((item) => item.to === relative);
    assert.ok(entry, `Alpha must carry ${relative}`);
    mkdirSync(dirname(join(exported, entry.to)), { recursive: true });
    copyFileSync(join(root, entry.from), join(exported, entry.to));
  }
  const node = f.node("node");
  for (const plugin of plugins) {
    for (const base of [root, exported]) {
      const cwd = resolve(base, "tools", plugin);
      const text = readFileSync(join(cwd, "herdr-plugin.toml"), "utf8");
      const commands = [...text.matchAll(/^command = (\[.*\])$/gm)].map((m) => JSON.parse(m[1]));
      assert.ok(commands.length > 0);
      for (const command of commands) {
        assert.deepEqual(command.slice(0, 2), ["/bin/sh", "../herdr-node/launch.sh"]);
        assert.ok(existsSync(resolve(root, "tools", plugin, command[2])), command[2]);
        // Substitute a side-effect-free probe; preserve the manifest's launcher and cwd.
        launched(f.run({ HERDR_NODE: node, HERDR_PLUGIN_ID: plugin }, [f.probe, "space argument", "--flag"], cwd, command[1]), node);
      }
    }
  }
});
