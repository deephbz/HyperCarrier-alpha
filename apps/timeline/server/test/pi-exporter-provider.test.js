import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { createLiveDetailServer, resolveNativeExporter } from "../live-detail.js";
import { BUNDLED_PI_EXPORTER_MANIFEST, resolveBundledPiExporter } from "../pi-exporter-provider.js";

const watchSources = () => ({ close() {} });

test("provider rejects an installed package whose patched exporter payload was mutated", () => {
  const root = mkdtempSync(join(tmpdir(), "hc-mutated-pi-provider-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "core/export-html"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.80.10" }),
  );
  writeFileSync(join(dist, "index.js"), "export {};\n");
  writeFileSync(join(dist, "core/export-html/template.js"), "// mutated recursive payload\n");
  writeFileSync(join(dist, "cli.js"), "#!/usr/bin/env node\n");
  chmodSync(join(dist, "cli.js"), 0o755);
  assert.throws(
    () =>
      resolveBundledPiExporter({
        resolvePackage: () => join(dist, "index.js"),
      }),
    /Installed Pi exporter payload SHA-256 does not match/,
  );
});

test("installed default provider resolves and exports a 6000-deep Session through Live Detail", async (t) => {
  const manifest = JSON.parse(readFileSync(BUNDLED_PI_EXPORTER_MANIFEST, "utf8"));
  const providerRoot = new URL("../../../../vendor/pi-exporter/", import.meta.url);
  const patch = readFileSync(new URL("deep-tree.patch", providerRoot));
  assert.equal(createHash("sha256").update(patch).digest("hex"), manifest.source.patchSha256);
  assert.equal(manifest.source.baseRevision, "8dc78834cde4e329284cf505f9e3f99763df5529");
  assert.equal(manifest.source.patchRevision, "2c31ffc14735315638abf02078117bbbf7868ac0");
  assert.equal(manifest.license.spdx, "MIT");

  const identity = resolveNativeExporter({ env: {} });
  assert.equal(identity.capability, "stack-safe");
  assert.equal(identity.provider.kind, "bundled-package");
  assert.equal(identity.provider.patchRevision, manifest.source.patchRevision);
  assert.equal(isAbsolute(identity.executable), true);
  assert.equal(realpathSync(identity.executable), identity.executable);
  accessSync(identity.executable);

  const root = mkdtempSync(join(tmpdir(), "hc-default-pi-provider-"));
  const id = "provider-deep-session";
  const rows = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/sanitized",
    },
  ];
  for (let index = 0; index < 6_000; index += 1)
    rows.push({
      type: "message",
      id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "x", timestamp: 1_767_225_600_000 },
    });
  writeFileSync(join(root, "session.jsonl"), `${rows.map(JSON.stringify).join("\n")}\n`);

  const server = createLiveDetailServer({
    sessionsRoot: root,
    cacheRoot: join(root, "cache"),
    env: {},
    watchSources,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.deepEqual(health.exporter, identity);

  const response = await fetch(`${base}/render/${id}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /const sortStack = \[\.\.\.roots\]/);
  assert.match(html, /const mapStack = \[\.\.\.tree\]/);
  assert.match(html, /const markStack = \[\]/);
});
