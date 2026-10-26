import "./bound.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { runDaemon } from "../src/node/daemon.ts";
import { readPiResources } from "../src/node/pi-config.ts";
import { TestClient, tempHome } from "./helpers.ts";

// The anchor is the installed Pi: its loaders and prompt builder for the same files and working directory. The test
// runner names its program directory in AMPI_PI_DIST, since each file runs under a temporary HOME; a bare run uses HOME.
const versionFile = join(homedir(), ".pi", "agent", "install", "current-version");
const piDist = process.env.AMPI_PI_DIST ?? (existsSync(versionFile)
	? join(homedir(), ".pi", "agent", "install", "releases", readFileSync(versionFile, "utf8").trim(), "node_modules", "@earendil-works", "pi-coding-agent", "dist")
	: undefined);
const skip = piDist && existsSync(join(piDist, "index.js")) ? false : "the installed Pi is absent (~/.pi/agent/install or AMPI_PI_DIST)";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
const PI_TOOLS = ["read", "bash", "edit", "write", "codemode"];

/** Pi's resource layout across scopes: settings paths, packages, `.agents/skills`, a collision, context files. */
function fixture(base: string) {
	const w = (path: string, text: string) => {
		mkdirSync(dirname(join(base, path)), { recursive: true });
		writeFileSync(join(base, path), text);
	};
	const skill = (path: string, name: string, description = `desc ${name}`) => w(path, `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
	const home = join(base, "home");
	const agent = join(home, ".pi", "agent");
	const repo = join(base, "repo");
	const proj = join(repo, "sub", "proj");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(proj, { recursive: true });
	skill("home/.pi/agent/skills/alpha/SKILL.md", "alpha", "|\n  Block scalar\n  description & <xml>");
	skill("home/.pi/agent/skills/group/nested/SKILL.md", "nested");
	skill("home/.pi/agent/skills/dup/SKILL.md", "dup", "agent dup");
	skill("home/.pi/agent/skills/hidden/SKILL.md", "hidden");
	w("home/.pi/agent/skills/hidden/SKILL.md", "---\nname: hidden\ndescription: not for the model\ndisable-model-invocation: true\n---\n");
	w("home/.pi/agent/skills/loose.md", "---\nname: loose\ndescription: loose md\n---\n");
	skill("home/.agents/skills/homeagents/SKILL.md", "homeagents");
	skill("repo/.agents/skills/repoagents/SKILL.md", "repoagents");
	skill("repo/sub/proj/.agents/skills/projagents/SKILL.md", "projagents");
	skill("repo/sub/proj/.pi/skills/dup/SKILL.md", "dup", "project dup");
	skill("repo/sub/proj/.pi/skills/beta/SKILL.md", "beta");
	skill("repo/.pi/skills/repopi/SKILL.md", "repopi");
	skill("extra/global-skill/SKILL.md", "globalsetting");
	skill("extra/proj-skill/SKILL.md", "projsetting");
	skill("pkg/skills/pkgskill/SKILL.md", "pkgskill");
	w("pkg/package.json", JSON.stringify({ name: "pkg" }));
	w("pkg/prompts/pkgprompt.md", "---\ndescription: pkg prompt\n---\nbody");
	skill("pkg2/res/sk/p2/SKILL.md", "pkg2skill");
	w("pkg2/package.json", JSON.stringify({ name: "pkg2", pi: { skills: ["./res/sk"] } }));
	// A plain package entry with a `pi` manifest loads only what the manifest lists: here, no skills.
	skill("pkg3/skills/manifestonly/SKILL.md", "manifestonly");
	w("pkg3/package.json", JSON.stringify({ name: "pkg3", pi: { extensions: ["./"] } }));
	// A linked worktree nested in its main checkout, with its own context file.
	w("repo/.git/HEAD", "ref: refs/heads/main\n");
	w("repo/.git/worktrees/wt/HEAD", "ref: refs/heads/wt\n");
	w("repo/.git/worktrees/wt/commondir", "../..\n");
	w("repo/.worktrees/wt/.git", `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
	w("repo/.worktrees/wt/CLAUDE.md", "worktree claude");
	mkdirSync(join(repo, ".worktrees", "wt", "pkg"), { recursive: true });
	w("home/.pi/agent/prompts/gp.md", "global prompt that is longer than sixty characters, so Pi cuts it short\nline2");
	w("repo/sub/proj/.pi/prompts/pp.md", "---\ndescription: proj\nargument-hint: <file>\n---\nx");
	w("repo/.pi/prompts/rp.md", "repo prompt");
	w("extra/gprompts/gsp.md", "x");
	w("extra/pprompts/psp.md", "y");
	w("home/.pi/agent/AGENTS.md", "global agents");
	w("repo/CLAUDE.md", "repo claude");
	w("repo/sub/proj/AGENTS.override.md", "override wins");
	w("repo/sub/proj/AGENTS.md", "shadowed");
	w("home/.pi/agent/SYSTEM.md", "sys global");
	w("repo/sub/proj/.pi/APPEND_SYSTEM.md", "append from the project");
	const settings = (extra: object) =>
		w("home/.pi/agent/settings.json", JSON.stringify({ skills: [join(base, "extra/global-skill")], packages: [join(base, "pkg"), join(base, "pkg3")], prompts: [join(base, "extra/gprompts")], defaultTools: ["+codemode"], ...extra }));
	w("repo/sub/proj/.pi/settings.json", JSON.stringify({ skills: ["../../../../extra/proj-skill"], packages: ["../../../../pkg2"], prompts: ["../../../../extra/pprompts"], defaultTools: ["-edit"] }));
	return { home, agent, repo, proj, worktree: join(repo, ".worktrees", "wt", "pkg"), settings, w };
}

/** Pi's view of `cwd`: trust, resources, the resolved tools, and the structured prompt sections. */
async function piView(cwd: string, agent: string) {
	const pi = await import(join(piDist!, "index.js"));
	const { buildSystemPromptSections } = await import(join(piDist!, "core", "system-prompt.js"));
	const global = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
	const trusted = pi.hasTrustRequiringProjectResources(cwd) ? (new pi.ProjectTrustStore(agent).get(cwd) ?? global.defaultProjectTrust === "always") : true;
	const settingsManager = pi.SettingsManager.create(cwd, agent, { projectTrusted: trusted });
	const loader = new pi.DefaultResourceLoader({ cwd, agentDir: agent, settingsManager, noExtensions: true });
	await loader.reload();
	const skills = loader.getSkills().skills;
	const tools: string[] = settingsManager.getDefaultTools() ?? ["read", "bash", "edit", "write"];
	const system: string | undefined = loader.getSystemPrompt();
	const append: string[] = loader.getAppendSystemPrompt();
	const sections: Record<string, string> = buildSystemPromptSections({
		cwd,
		customPrompt: system,
		appendSystemPrompt: append.join("\n\n"),
		contextFiles: loader.getAgentsFiles().agentsFiles,
		skills,
		selectedTools: tools,
	});
	return {
		trusted,
		tools,
		system,
		sections,
		skills: skills.map((s: any) => `${s.name}@${s.filePath}`),
		prompts: loader.getPrompts().prompts.map((p: any) => `${p.name}@${p.filePath}|${p.description}|${p.argumentHint ?? ""}`),
		agents: loader.getAgentsFiles().agentsFiles.map((f: any) => f.path),
	};
}

test("prompt parity: resources, tools, and the assembled system prompt match Pi's for the same directory", { skip }, async () => {
	const base = tempHome();
	const { home, agent, repo, proj, worktree, settings, w } = fixture(base);
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agent;
	const daemon = await runDaemon({ home: join(base, "ampi"), agentDir: agent, simTokensPerSecond: 50000 });
	try {
		const client = await TestClient.connect(daemon.socket);
		const cases: [label: string, extra: object, trust?: object][] = [
			["trusted by defaultProjectTrust", { defaultProjectTrust: "always" }],
			["untrusted by default", {}],
			["a saved decision overrides the default", { defaultProjectTrust: "always" }, { [repo]: false }],
		];
		for (const [index, [label, extra, trust]] of cases.entries()) {
			settings(extra);
			w("home/.pi/agent/trust.json", JSON.stringify(trust ?? {}));
			const pi = await piView(proj, agent);
			const ours = readPiResources(proj, { agentDir: agent, home });
			assert.equal(ours.trust === "trusted", pi.trusted, `${label}: trust`);
			assert.deepEqual(ours.skills.map((s) => `${s.name}@${s.path}`), pi.skills, `${label}: skills and their order`);
			assert.deepEqual(ours.prompts.map((p) => `${p.name}@${p.path}|${p.description}|${p.argumentHint ?? ""}`), pi.prompts, `${label}: prompt templates`);
			assert.deepEqual(ours.contextFiles.map((f) => f.path), pi.agents, `${label}: context files`);
			assert.deepEqual(ours.tools, pi.tools, `${label}: defaultTools`);

			// The assembled prompt of a real thread: committed pi.system, replayed as the provider sees it.
			const { threadId } = await client.req("thread.create", { requestId: `parity-${index}`, cwd: proj, model: SIM, place: { workspace: "new", label }, prompt: "hi" });
			const threads = client.sub({ kind: "threads" });
			await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId].preview !== undefined);
			const { store, conversationId } = await daemon.runtime.thread(threadId);
			const conversation = await store.conversation(conversationId);
			const view = await conversation.context(BACKGROUND_CONTEXT);
			const prompt = getCurrentSystemPrompt(view.messages);
			assert.ok(prompt.startsWith(`${pi.system}\n`), `${label}: SYSTEM.md replaces the base prompt`);
			for (const key of ["addendum", "project_context", "skills"]) {
				if (pi.sections[key]) assert.ok(prompt.includes(pi.sections[key]!), `${label}: Pi's <${key}> section appears verbatim`);
				else assert.ok(!prompt.includes(`<${key}>`), `${label}: no <${key}> section, as in Pi`);
			}
			assert.ok(!prompt.includes("not for the model"), "a disable-model-invocation skill stays out of the prompt");
			const offered = getCurrentTools(view.messages).map((tool) => tool.name).filter((name) => PI_TOOLS.includes(name));
			assert.deepEqual(offered.sort(), pi.tools.filter((name) => PI_TOOLS.includes(name)).sort(), `${label}: the offered tools`);
			assert.equal(prompt.includes("<codemode>"), pi.tools.includes("codemode"), `${label}: the codemode section follows its tool`);
		}
		// The worktree's own CLAUDE.md shadows the main checkout's, as in Pi.
		const pi = await piView(worktree, agent);
		const ours = readPiResources(worktree, { agentDir: agent, home });
		assert.deepEqual(ours.contextFiles.map((f) => f.path), pi.agents, "worktree: context files");
		assert.ok(!pi.agents.includes(join(repo, "CLAUDE.md")), "worktree: the main checkout's file is shadowed");
		assert.deepEqual(ours.skills.map((s) => `${s.name}@${s.path}`), pi.skills, "worktree: skills");
		client.close();
	} finally {
		await daemon.stop();
		Object.assign(process.env, saved);
		if (saved.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	}
});
