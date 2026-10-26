// One bootstrap for bare tests, runner tests, and test helpers. Never trust an inherited HOME or Pi agent directory.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Preserve only the installed Pi program for parity checks, before replacing HOME. No settings or credentials copy.
const version = join(homedir(), ".pi", "agent", "install", "current-version");
if (!process.env.AMPI_PI_DIST && existsSync(version))
	process.env.AMPI_PI_DIST = join(dirname(version), "releases", readFileSync(version, "utf8").trim(), "node_modules", "@earendil-works", "pi-coding-agent", "dist");
// Keep Playwright's browser cache (browser binaries only), so a WebKit test finds its installed build.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const home = mkdtempSync(join(tmpdir(), "ampi-test-home-"));
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.AMPI_TEST_MODE = "1";
delete process.env.AMPI_MODEL;
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
