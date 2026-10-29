// One bootstrap for bare tests, runner tests, and test helpers. Never trust an inherited HOME or Pi agent directory.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

// Preserve only the installed Pi program for parity checks, before replacing HOME. No settings or credentials copy.
const version = join(homedir(), ".pi", "agent", "install", "current-version");
if (!process.env.AMPI_PI_DIST && existsSync(version))
	process.env.AMPI_PI_DIST = join(dirname(version), "releases", readFileSync(version, "utf8").trim(), "node_modules", "@earendil-works", "pi-coding-agent", "dist");
// Keep Playwright's browser cache (browser binaries only), so a WebKit test finds its installed build.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const home = mkdtempSync(join(tmpdir(), "ampi-test-home-"));
const agentDir = join(home, ".pi", "agent");
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
// Prove that user paths now resolve inside the fresh HOME before any test code runs. Bun caches os.homedir() at
// start, so a HOME set here does not reach it; on 2026-10-29 a Bun run of another suite wrote the operator's ~/.pi.
const resolved = realpathSync(homedir()), operator = realpathSync(userInfo().homedir);
if (resolved !== realpathSync(home) || resolved === operator)
	throw new Error(`HOME isolation failed: os.homedir() is ${resolved}, HOME is ${home}, the operator HOME is ${operator}. This runtime does not follow a HOME set at runtime; run the tests under Node. No test code ran.`);
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });
process.env.AMPI_TEST_MODE = "1";
delete process.env.AMPI_MODEL;
