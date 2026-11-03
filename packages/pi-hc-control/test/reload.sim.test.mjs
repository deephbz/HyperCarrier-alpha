// Pi's /reload re-evaluates only the files its loader (jiti, moduleCache off) transpiles. Node's native ESM loader
// keeps `.mjs`, `.cjs`, and `.js` under "type": "module" for the process life (b16, 2026-11-04). This proves that
// an edit to the control's source runs after an in-process reload, so a new build needs no Pi restart.
import "./home.mjs";
import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SimWorld } from "@hypercarrier/pi-sim";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

test("an in-process reload runs the edited control source", async () => {
  const handles = [];
  // The path-loaded copy cannot take a factory option, so the test entry reads the recorder transport from here.
  globalThis.__hcReloadListen = async (_path, handle) => {
    handles.push(handle);
    return { close: async () => {} };
  };
  let copy;
  const world = await SimWorld.create({
    seed: 11,
    replies: [],
    setup: async ({ root }) => {
      copy = join(root, "pi-hc-control");
      cpSync(join(PKG, "src"), join(copy, "src"), { recursive: true });
      writeFileSync(join(copy, "package.json"), JSON.stringify(MANIFEST));
      writeFileSync(
        join(copy, "test-entry.ts"),
        `import { createHcControlExtension } from "./${MANIFEST.pi.extensions[0].replace(/^\.\//, "")}";\n` +
          "export default createHcControlExtension({ listen: (globalThis as any).__hcReloadListen, stamp: null });\n",
      );
      return { extensionPaths: [join(copy, "test-entry.ts")] };
    },
  });
  try {
    const unknown = async () => (await world.run(() => handles.at(-1)({ id: 1, op: "no-such-op" }))).error.message;
    assert.match(await unknown(), /^op must be /);
    const control = readdirFile(join(copy, "src"), /^control\./);
    writeFileSync(control, readFileSync(control, "utf8").replace('"op must be ', '"RELOADED op must be '));
    const before = handles.length;
    await world.run(() => world.session.reload());
    assert.ok(handles.length > before, "the reload opened no new endpoint");
    assert.match(await unknown(), /^RELOADED op must be /, "the reload kept the old control code");
    world.assertHealthy();
  } finally {
    delete globalThis.__hcReloadListen;
    await world.close();
  }
});

function readdirFile(dir, pattern) {
  const name = readdirSync(dir).find((n) => pattern.test(n));
  assert.ok(name, `no ${pattern} in ${dir}`);
  return join(dir, name);
}
