// Emit one checkout-independent Node bundle. The installed Host needs Node,
// Perl and Pi; no npm install or source checkout belongs on that path.
import { execFileSync } from "node:child_process";
import { rolldown } from "rolldown";
import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildArcService(output = resolve(root, "build/arc-service.mjs"), options = {}) {
 const candidate = Object.hasOwn(options, "releaseLine") ? options.releaseLine : process.env.AMPI_RELEASE_LINE ?? (existsSync(resolve(root, "../../release/public/export-manifest.durable.json")) ? "durable" : "stable");
 const releaseLine = candidate === "stable" || candidate === "durable" ? candidate : null;
 const extension = stripTypeScriptTypes(readFileSync(resolve(root, "src/pi/ask-limit.ts"), "utf8"));
 const buildOrder = Object.hasOwn(options, "buildOrder") ? options.buildOrder : Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
 if (!Number.isSafeInteger(buildOrder) || buildOrder < 0) throw new Error("Arc build requires a non-negative integer buildOrder");
 const bundle = await rolldown({
  input: resolve(root, "src/arc/service/entry.ts"), platform: "node",
  transform: { define: { __ARC_RELEASE_LINE__: JSON.stringify(releaseLine), __ARC_BUILD_ORDER__: JSON.stringify(buildOrder), __ARC_VERSION__: JSON.stringify("__AMPI_ARC_VERSION__"), __ARC_OUTPUT_LIMIT_SOURCE__: JSON.stringify(extension) } },
 });
 try {
  const result = await bundle.generate({ format: "esm", sourcemap: false });
  if (result.output.length !== 1 || result.output[0].type !== "chunk") throw new Error("Arc service must ship as one bundle");
  const chunk = result.output[0];
  if ([...chunk.imports, ...chunk.dynamicImports].some(name => !name.startsWith("node:"))) throw new Error("Arc service has a non-built-in runtime dependency");
  const sourceReader = Object.keys(chunk.modules).some(name => name.endsWith("/trace-analytics/src/sources/transcript-range.mjs"));
  if (!sourceReader) throw new Error("Arc service omitted the original transcript reader");
  const code = chunk.code;
  const version = "2.1.0-" + createHash("sha256").update(code).digest("hex").slice(0, 16);
  const body = "// Arc service " + version + "\n" + code.replaceAll("__AMPI_ARC_VERSION__", version);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, body);
  return { output, version, releaseLine, buildOrder, sourceReader, bytes: Buffer.byteLength(body) };
 } finally { await bundle.close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildArcService(process.argv[2])));
