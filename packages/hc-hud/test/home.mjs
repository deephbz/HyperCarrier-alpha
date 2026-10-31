// Test HOME isolation: import this module first in every test file, or load it as a Vitest setup file. It gives the
// test process a fresh HOME with a quiet Git config and proves that os.homedir() follows it before any test code
// runs. Bun caches os.homedir() at start, so a HOME set at runtime does not reach it; on 2026-10-29 a Bun test run
// wrote the operator's ~/.pi this way. scripts/verify-test-home.mjs keeps every copy of this file identical.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hc-test-home-"));
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
// Pi paths then default inside the fresh HOME; a test that needs an agent directory sets its own.
delete process.env.PI_CODING_AGENT_DIR;
// Pi's provider auth reads these from the environment, so a caller's key signs a test in (2026-10-31: an Amp orb's
// ANTHROPIC_API_KEY failed an AmPi test). Match families, not Pi's per-provider table, so a new provider stays out too.
const PROVIDER_CREDENTIAL = /_API_KEY$|^(ANTHROPIC|AWS|AZURE_OPENAI|GOOGLE_CLOUD|GCLOUD)_|^(GOOGLE_APPLICATION_CREDENTIALS|HF_TOKEN|COPILOT_GITHUB_TOKEN)$/;
for (const name of Object.keys(process.env)) if (PROVIDER_CREDENTIAL.test(name)) delete process.env[name];
const resolved = realpathSync(homedir()), operator = realpathSync(userInfo().homedir);
if (resolved !== realpathSync(home) || resolved === operator)
	throw new Error(`HOME isolation failed: os.homedir() is ${resolved}, HOME is ${home}, the operator HOME is ${operator}. This runtime does not follow a HOME set at runtime; run the tests under Node. No test code ran.`);
// A writing Git command starts a detached `git maintenance run --auto`. It holds objects/maintenance.lock and can pack
// objects after the command returns, so a test that copies or removes its repository next races it (2026-10-31: an
// AmPi test failed cpSync with ENOENT under .git/objects on a hosted macOS runner). This is the only global Git config.
const gitConfig = join(home, ".gitconfig");
writeFileSync(gitConfig, "[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n");
process.env.GIT_CONFIG_GLOBAL = gitConfig;
