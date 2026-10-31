// Pi's configuration as Pi 1.4 resolves it for one working directory: settings (global, then the trusted project's),
// project trust, context files, SYSTEM.md / APPEND_SYSTEM.md, skills, prompt templates, packages, and `defaultTools`.
// The node and Pi read the same files, so a thread and a Pi Session in one directory see the same resources.
// Pi's own loaders are the authority; test/node-prompt-parity.test.ts compares this module with them.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertTestIsolation } from "./test-mode.ts";

export function piAgentDir(): string {
	assertTestIsolation();
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// biome-ignore lint/suspicious/noExplicitAny: settings files are not validated, as in Pi.
export type PiSettings = Record<string, any>;

export type Skill = { name: string; description: string; path: string; disableModelInvocation?: boolean };
export type PromptTemplate = { name: string; description: string; body: string; path: string; argumentHint?: string };

export type PiResources = {
	cwd: string;
	agentDir: string;
	/** Project trust: `none` when the project has no trust-protected resources. */
	trust: "trusted" | "untrusted" | "none";
	/** Global settings merged with the trusted project's, as Pi merges them. */
	settings: PiSettings;
	contextFiles: { path: string; content: string }[];
	/** SYSTEM.md: replaces the base prompt. The trusted project's file wins over the agent directory's. */
	systemPrompt?: { path: string; content: string };
	appendSystemPrompt?: { path: string; content: string };
	skills: Skill[];
	prompts: PromptTemplate[];
	/** Resolved `defaultTools`: the tools enabled at start. */
	tools: string[];
};

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const PROTECTED = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];

function readJson(path: string): PiSettings {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isObject(value: unknown): value is PiSettings {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModifier(entry: unknown): boolean {
	return typeof entry === "string" && (entry.startsWith("+") || entry.startsWith("-"));
}

function deepMerge(base: PiSettings, override: PiSettings): PiSettings {
	const result: PiSettings = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		result[key] = isObject(base[key]) && isObject(value) ? deepMerge(base[key], value) : value;
	}
	// A `defaultTools` list of only +name/-name entries modifies the inherited one.
	if (Array.isArray(base.defaultTools) && Array.isArray(override.defaultTools) && override.defaultTools.every(isModifier))
		result.defaultTools = [...base.defaultTools, ...override.defaultTools];
	return result;
}

/** Pi's `defaultTools` rule: plain names replace the defaults, then `+name` adds and `-name` removes, in order. */
export function resolveTools(entries: unknown): string[] {
	if (!Array.isArray(entries)) return [...DEFAULT_TOOLS];
	const list = entries.filter((entry): entry is string => typeof entry === "string");
	const plain = list.filter((entry) => !isModifier(entry));
	const tools = plain.length > 0 || list.length === 0 ? plain : [...DEFAULT_TOOLS];
	for (const entry of list) {
		if (!isModifier(entry)) continue;
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}

/** The directory and its ancestors up to the enclosing Git repository's root, nearest first; just `cwd` outside one. */
function upToRepoRoot(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		dirs.push(dir);
		if (existsSync(join(dir, ".git"))) return dirs;
		const parent = dirname(dir);
		if (parent === dir) return dirs;
		dir = parent;
	}
}

function hasProtectedResources(cwd: string, home: string): boolean {
	if (PROTECTED.some((name) => existsSync(join(cwd, ".pi", name)))) return true;
	const userSkills = canonical(join(home, ".agents", "skills"));
	return upToRepoRoot(cwd).some((dir) => {
		const skills = join(dir, ".agents", "skills");
		return existsSync(skills) && canonical(skills) !== userSkills;
	});
}

/**
 * Pi's non-interactive trust decision: the nearest saved decision in `<agent-dir>/trust.json`, else the global
 * `defaultProjectTrust` (`always` trusts; `ask` and `never` skip, as in Pi's print and RPC modes).
 */
export function projectTrusted(cwd: string, agentDir: string, defaultProjectTrust: unknown): boolean {
	const saved = readJson(join(agentDir, "trust.json"));
	let dir = canonical(cwd);
	for (;;) {
		if (saved[dir] === true || saved[dir] === false) return saved[dir];
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return defaultProjectTrust === "always";
}

/** Context files from the agent directory, then from the filesystem root down to `cwd` (nearest last). */
function contextFile(dir: string): { path: string; content: string } | undefined {
	for (const name of CONTEXT_NAMES) {
		const path = join(dir, name);
		try {
			if (!statSync(path).isFile()) continue;
		} catch {
			continue;
		}
		const content = readText(path);
		if (content !== undefined) return { path, content: content.replace(/^\uFEFF/, "") };
	}
	return undefined;
}

/** The nearest Git checkout above `cwd`: its root and the common Git dir (a linked worktree's `.git` is a file). */
function gitPaths(cwd: string): { repoDir: string; commonGitDir: string } | undefined {
	for (let dir = cwd; ; ) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				if (statSync(gitPath).isDirectory()) return existsSync(join(gitPath, "HEAD")) ? { repoDir: dir, commonGitDir: gitPath } : undefined;
				const content = readFileSync(gitPath, "utf8").trim();
				if (!content.startsWith("gitdir: ")) return undefined;
				const gitDir = resolve(dir, content.slice(8).trim());
				if (!existsSync(join(gitDir, "HEAD"))) return undefined;
				const common = join(gitDir, "commondir");
				return { repoDir: dir, commonGitDir: existsSync(common) ? resolve(gitDir, readFileSync(common, "utf8").trim()) : gitDir };
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Pi's worktree rule: a linked worktree nested inside its main checkout shadows the main checkout's context file
 * when the worktree has its own, so the same repository context loads once. Returns the shadowed real path.
 */
function shadowedContextFile(cwd: string): string | undefined {
	const git = gitPaths(cwd);
	if (!git) return undefined;
	const common = canonical(git.commonGitDir);
	const worktree = canonical(git.repoDir);
	const main = dirname(common);
	if (!worktree.startsWith(`${main}${sep}`)) return undefined;
	if (canonical(join(main, ".git")) !== common) return undefined;
	const own = contextFile(worktree);
	return own ? join(main, basename(own.path)) : undefined;
}

function contextFiles(cwd: string, agentDir: string): { path: string; content: string }[] {
	const found: { path: string; content: string }[] = [];
	const global = contextFile(agentDir);
	if (global) found.push(global);
	const shadowed = shadowedContextFile(resolve(cwd));
	const chain: string[] = [];
	for (let dir = resolve(cwd); ; ) {
		chain.unshift(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const dir of chain) {
		const file = contextFile(dir);
		if (!file || found.some((known) => known.path === file.path)) continue;
		if (shadowed !== undefined && join(canonical(dir), basename(file.path)) === shadowed) continue;
		found.push(file);
	}
	return found;
}

const MAX_DESCRIPTION = 1024;

/** YAML frontmatter as skills and prompt templates use it: `key: value`, quoted values, and `|` / `>` blocks. */
export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return { fields: {}, body: text };
	const fields: Record<string, string> = {};
	const lines = match[1]!.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
		if (!field) continue;
		let value = field[2]!.trim();
		const block = /^([|>])([+-]?)$/.exec(value);
		const continued: string[] = [];
		while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || (block && lines[i + 1]!.trim() === ""))) continued.push(lines[++i]!.trim());
		if (block) {
			// YAML chomping: `|` / `>` keep one final newline, `-` strips it.
			const body = continued.join(block[1] === "|" ? "\n" : " ").replace(/\s+$/, "");
			fields[field[1]!] = block[2] === "-" || body === "" ? body : `${body}\n`;
			continue;
		}
		if (continued.length > 0) value = [value, ...continued].join(" ");
		if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"');
		else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
		fields[field[1]!] = value;
	}
	return { fields, body: text.slice(match[0].length) };
}

function entriesOf(dir: string): { name: string; path: string; dir: boolean; file: boolean }[] {
	try {
		return readdirSync(dir).map((name) => {
			const path = join(dir, name);
			try {
				const stats = statSync(path);
				return { name, path, dir: stats.isDirectory(), file: stats.isFile() };
			} catch {
				return { name, path, dir: false, file: false };
			}
		});
	} catch {
		return [];
	}
}

function skillFromFile(path: string): Skill | undefined {
	const text = readText(path);
	if (text === undefined) return undefined;
	const { fields } = frontmatter(text);
	const description = fields.description;
	if (!description?.trim()) return undefined;
	return {
		name: fields.name || basename(dirname(path)),
		description: description.slice(0, MAX_DESCRIPTION),
		path,
		...(fields["disable-model-invocation"] === "true" ? { disableModelInvocation: true } : {}),
	};
}

/** Pi's skill discovery in one directory: a `SKILL.md` ends the descent; root `.md` files are standalone skills. */
function skillsIn(dir: string, root = true): Skill[] {
	const entries = entriesOf(dir);
	const declared = entries.find((entry) => entry.name === "SKILL.md" && entry.file);
	if (declared) {
		const skill = skillFromFile(declared.path);
		return skill ? [skill] : [];
	}
	const skills: Skill[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (entry.dir) skills.push(...skillsIn(entry.path, false));
		else if (root && entry.file && entry.name.endsWith(".md")) {
			const skill = skillFromFile(entry.path);
			if (skill) skills.push(skill);
		}
	}
	return skills;
}

function skillsAt(path: string): Skill[] {
	if (!existsSync(path)) return [];
	try {
		if (statSync(path).isDirectory()) return skillsIn(path);
	} catch {
		return [];
	}
	const skill = path.endsWith(".md") ? skillFromFile(path) : undefined;
	return skill ? [skill] : [];
}

function promptFromFile(path: string): PromptTemplate | undefined {
	const text = readText(path);
	if (text === undefined) return undefined;
	const { fields, body } = frontmatter(text);
	let description = fields.description ?? "";
	if (!description) {
		const first = body.split("\n").find((line) => line.trim());
		if (first) description = first.length > 60 ? `${first.slice(0, 60)}...` : first;
	}
	return { name: basename(path).replace(/\.md$/, ""), description, body, path, ...(fields["argument-hint"] ? { argumentHint: fields["argument-hint"] } : {}) };
}

function promptsAt(path: string): PromptTemplate[] {
	if (!existsSync(path)) return [];
	try {
		if (statSync(path).isFile()) {
			const prompt = path.endsWith(".md") ? promptFromFile(path) : undefined;
			return prompt ? [prompt] : [];
		}
	} catch {
		return [];
	}
	return entriesOf(path)
		.filter((entry) => entry.file && entry.name.endsWith(".md"))
		.flatMap((entry) => promptFromFile(entry.path) ?? []);
}

function expand(path: string, base: string): string {
	const trimmed = path.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? trimmed : resolve(base, trimmed);
}

/** Paths of a package manifest entry; a `*` segment matches names, as in `prompts/*.md`. */
function globPaths(root: string, pattern: string): string[] {
	if (pattern.startsWith("!")) return [];
	const parts = relative(".", pattern.replace(/^\.\//, "")).split("/");
	let paths = [root];
	for (const part of parts) {
		if (!part.includes("*")) {
			paths = paths.map((path) => join(path, part));
			continue;
		}
		const matcher = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
		paths = paths.flatMap((path) => entriesOf(path).filter((entry) => matcher.test(entry.name)).map((entry) => entry.path));
	}
	return paths.filter((path) => existsSync(path));
}

type PackageScope = { settingsDir: string; installRoot: string };

/** The installed directory of a `packages` entry: npm and git sources under the scope's install root, else a path. */
function packageDir(source: string, scope: PackageScope): string {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4);
		const name = spec.startsWith("@") ? `@${spec.slice(1).split("@")[0]}` : spec.split("@")[0]!;
		return join(scope.installRoot, "npm", "node_modules", name);
	}
	const git = /^(?:git:|https?:\/\/|ssh:\/\/|git@)([^/:]+)[/:](.+?)(?:\.git)?(?:@[^/]*)?$/.exec(source);
	if (git) return join(scope.installRoot, "git", git[1]!, git[2]!);
	return expand(source, scope.settingsDir);
}

function packageResources(entry: unknown, scope: PackageScope, kind: "skills" | "prompts"): string[] {
	const source = typeof entry === "string" ? entry : isObject(entry) && typeof entry.source === "string" ? entry.source : undefined;
	if (!source) return [];
	// The object form narrows a package's resources; `[]` loads none. Other filters are not applied yet (provisional).
	if (isObject(entry) && Array.isArray(entry[kind]) && entry[kind].length === 0) return [];
	const root = packageDir(source, scope);
	if (!existsSync(root)) return [];
	if (!statSync(root).isDirectory()) return [];
	const manifest = readJson(join(root, "package.json")).pi;
	if (isObject(manifest) && Array.isArray(manifest[kind]) && manifest[kind].length > 0)
		return manifest[kind].filter((path: unknown): path is string => typeof path === "string").flatMap((path: string) => globPaths(root, path));
	// Pi: a plain entry with a manifest loads only the manifest's entries; an object entry falls back to the convention dir.
	if (isObject(manifest) && !isObject(entry)) return [];
	return [join(root, kind)];
}

function stringPaths(value: unknown, base: string): string[] {
	return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string").map((path) => expand(path, base)) : [];
}

function firstByName<T extends { name: string; path: string }>(items: T[]): T[] {
	const byName = new Map<string, T>();
	const files = new Set<string>();
	for (const item of items) {
		const file = canonical(item.path);
		if (files.has(file) || byName.has(item.name)) continue;
		byName.set(item.name, item);
		files.add(file);
	}
	return [...byName.values()];
}

export type PiConfigOptions = { agentDir?: string; home?: string };

export function readPiResources(cwd: string, options: PiConfigOptions = {}): PiResources {
	assertTestIsolation();
	const agentDir = resolve(options.agentDir ?? piAgentDir());
	const home = options.home ?? homedir();
	const dir = resolve(cwd);
	const global = readJson(join(agentDir, "settings.json"));
	const protectedResources = hasProtectedResources(dir, home);
	const trusted = !protectedResources || projectTrusted(dir, agentDir, global.defaultProjectTrust);
	const projectPi = join(dir, ".pi");
	const project = trusted && protectedResources ? readJson(join(projectPi, "settings.json")) : {};
	const settings = deepMerge(global, project);
	const useProject = trusted && protectedResources;

	const fileOf = (name: string) => {
		for (const path of [...(useProject ? [join(projectPi, name)] : []), join(agentDir, name)]) {
			const content = existsSync(path) ? readText(path) : undefined;
			if (content !== undefined) return { path, content };
		}
		return undefined;
	};

	const projectScope: PackageScope = { settingsDir: projectPi, installRoot: projectPi };
	const userScope: PackageScope = { settingsDir: agentDir, installRoot: agentDir };
	const projectPackages = useProject && Array.isArray(project.packages) ? project.packages : [];
	const userPackages = Array.isArray(global.packages) ? global.packages : [];

	const skillRoots = [
		...(useProject
			? [
					...stringPaths(project.skills, projectPi),
					join(projectPi, "skills"),
					...upToRepoRoot(dir)
						.map((path) => join(path, ".agents", "skills"))
						.filter((path) => canonical(path) !== canonical(join(home, ".agents", "skills"))),
				]
			: []),
		...stringPaths(global.skills, agentDir),
		join(agentDir, "skills"),
		join(home, ".agents", "skills"),
		...projectPackages.flatMap((entry) => packageResources(entry, projectScope, "skills")),
		...userPackages.flatMap((entry) => packageResources(entry, userScope, "skills")),
	];
	const promptRoots = [
		...(useProject ? [...stringPaths(project.prompts, projectPi), join(projectPi, "prompts")] : []),
		...stringPaths(global.prompts, agentDir),
		join(agentDir, "prompts"),
		...projectPackages.flatMap((entry) => packageResources(entry, projectScope, "prompts")),
		...userPackages.flatMap((entry) => packageResources(entry, userScope, "prompts")),
	];

	const systemPrompt = fileOf("SYSTEM.md");
	const appendSystemPrompt = fileOf("APPEND_SYSTEM.md");
	return {
		cwd: dir,
		agentDir,
		trust: protectedResources ? (trusted ? "trusted" : "untrusted") : "none",
		settings,
		contextFiles: contextFiles(dir, agentDir),
		...(systemPrompt ? { systemPrompt } : {}),
		...(appendSystemPrompt ? { appendSystemPrompt } : {}),
		skills: firstByName(skillRoots.flatMap(skillsAt)),
		prompts: firstByName(promptRoots.flatMap(promptsAt)),
		tools: resolveTools(settings.defaultTools),
	};
}

const cache = new Map<string, { at: number; stamp: string; value: PiResources }>();

/**
 * How close to the read time an mtime makes a stamp racy. File times come from a coarse clock (a kernel tick on Linux,
 * whole seconds on some file systems), so a later edit of the same size can keep the mtime of an edit this recent.
 */
const RACY_MS = 2_000;

/**
 * A file's change stamp, `mtime:size`, or `-` when it is absent. A racy stamp (an mtime within RACY_MS of now, or in
 * the future) also carries a hash of the bytes, so a same-size edit inside one clock tick still moves it. A file older
 * than that costs one `stat`: any later edit gets a later mtime. The stamp changes form once when the file ages, which
 * costs one extra read.
 */
export function fileStamp(path: string): string {
	try {
		const stat = statSync(path);
		const stamp = `${stat.mtimeMs}:${stat.size}`;
		if (Date.now() - stat.mtimeMs >= RACY_MS) return stamp;
		return `${stamp}:${createHash("sha1").update(readFileSync(path)).digest("base64url")}`;
	} catch {
		return "-";
	}
}

/** Settings and trust decide which resources and settings load, so their stamp invalidates both caches at once. */
function stamp(cwd: string, agentDir: string): string {
	return [join(agentDir, "settings.json"), join(agentDir, "trust.json"), join(cwd, ".pi", "settings.json")].map(fileStamp).join("|");
}

/**
 * `readPiResources` behind a short cache: prompt sections render on every request, and discovery reads many files.
 * Settings and trust changes show at once; other edits (a new skill) show within 10 s, as `/reload` shows them in Pi.
 */
export function piResources(cwd: string, options: PiConfigOptions = {}): PiResources {
	const agentDir = resolve(options.agentDir ?? piAgentDir());
	const key = `${agentDir}\0${options.home ?? homedir()}\0${cwd}`;
	const current = stamp(resolve(cwd), agentDir);
	const hit = cache.get(key);
	if (hit && hit.stamp === current && Date.now() - hit.at < 10_000) return hit.value;
	const value = readPiResources(cwd, options);
	cache.set(key, { at: Date.now(), stamp: current, value });
	if (cache.size > 64) cache.delete(cache.keys().next().value!);
	return value;
}

/** Pi's settings files for one working directory, unmerged, and the stamp of the files they come from. */
export type PiSettingsLayers = { global: PiSettings; project: PiSettings; stamp: string };

const settingsCache = new Map<string, PiSettingsLayers>();

/** Pi's global settings file. */
export function piSettingsFile(options: PiConfigOptions = {}): string {
	return join(resolve(options.agentDir ?? piAgentDir()), "settings.json");
}

/** The stamp `piSettingsLayers(cwd)` would carry, from `stat` calls only: a poll compares it without reading JSON. */
export function piSettingsStamp(cwd: string | undefined, options: PiConfigOptions = {}): string {
	const agentDir = resolve(options.agentDir ?? piAgentDir());
	return cwd === undefined ? fileStamp(piSettingsFile({ agentDir })) : stamp(resolve(cwd), agentDir);
}

/**
 * Pi's global settings and, when `cwd` is given, its project's: they apply only when `.pi/settings.json` exists and
 * the project is trusted. The stamp covers that file, the global one and trust.json, so an edit shows at the next
 * call with no age limit. A cache hit costs three `stat` calls; the durable harness reads it on every commit.
 */
export function piSettingsLayers(cwd: string | undefined, options: PiConfigOptions = {}): PiSettingsLayers {
	assertTestIsolation();
	const agentDir = resolve(options.agentDir ?? piAgentDir());
	const dir = cwd === undefined ? undefined : resolve(cwd);
	const key = `${agentDir}\0${dir ?? ""}`;
	const current = piSettingsStamp(dir, { agentDir });
	const hit = settingsCache.get(key);
	if (hit?.stamp === current) return hit;
	const global = readJson(join(agentDir, "settings.json"));
	const projectFile = dir === undefined ? undefined : join(dir, ".pi", "settings.json");
	const project = projectFile && existsSync(projectFile) && projectTrusted(dir!, agentDir, global.defaultProjectTrust) ? readJson(projectFile) : {};
	const value = { global, project, stamp: current };
	settingsCache.set(key, value);
	if (settingsCache.size > 64) settingsCache.delete(settingsCache.keys().next().value!);
	return value;
}

/** Pi's merged settings for `cwd` (`PiResources.settings`) without resource discovery. */
export function piSettings(cwd: string, options: PiConfigOptions = {}): PiSettings {
	const { global, project } = piSettingsLayers(cwd, options);
	return deepMerge(global, project);
}
