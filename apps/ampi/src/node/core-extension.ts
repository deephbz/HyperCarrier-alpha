// The AmPi base agent: identity, working rules, environment, and project context files (AGENTS.md / CLAUDE.md from
// the working directory up to the filesystem root, plus the user's global file), rendered as stable sections so the
// provider prompt cache stays warm.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

const PREAMBLE = `You are an expert coding agent running inside AmPi, a durable agent harness. You help the user by reading files, running commands, editing code, and writing new files. Your work is committed to durable storage as it happens, so a crash or restart resumes where you stopped.

Rules:
- Read before you edit. Prefer small, exact edits over rewriting whole files.
- Use bash for searching (rg, find), building, and testing. Keep command output focused.
- When the task is done, say plainly what changed and how you verified it. Say when something is not verified.
- Ask the user only when a decision is genuinely theirs; otherwise make a reasonable choice and state it.`;

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_CONTEXT_CHARS = 60_000;

/** Context files from the global agent dir, then from the root down to `cwd` (nearest last, so it wins). */
export function loadContextFiles(cwd: string): { path: string; content: string }[] {
	const found: { path: string; content: string }[] = [];
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	for (const name of CONTEXT_FILES) {
		const path = join(agentDir, name);
		if (existsSync(path)) {
			found.push({ path, content: readFileSync(path, "utf8") });
			break;
		}
	}
	const chain: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		chain.unshift(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const directory of chain) {
		for (const name of CONTEXT_FILES) {
			const path = join(directory, name);
			if (existsSync(path)) {
				found.push({ path, content: readFileSync(path, "utf8") });
				break;
			}
		}
	}
	return found;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * `cwd` and its ancestors up to the enclosing Git repository's root, nearest first; just `cwd` outside a repository.
 * Shared directories above a project (`/tmp`, `/`) never contribute skills or templates to the prompt.
 */
function projectDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		dirs.push(dir);
		if (existsSync(join(dir, ".git"))) return dirs;
		const parent = dirname(dir);
		if (parent === dir) return [resolve(cwd)];
		dir = parent;
	}
}

const MAX_DESCRIPTION = 300;

/** Discovery runs on every prompt render; a short-lived cache keeps it off the event loop's hot path. */
function cached<T>(cache: Map<string, { at: number; value: T }>, key: string, load: () => T): T {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < 10_000) return hit.value;
	const value = load();
	cache.set(key, { at: Date.now(), value });
	if (cache.size > 64) cache.delete(cache.keys().next().value!);
	return value;
}
const skillCache = new Map<string, { at: number; value: Skill[] }>();
const promptCache = new Map<string, { at: number; value: PromptTemplate[] }>();

function frontmatter(text: string): { fields: Record<string, string>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return { fields: {}, body: text };
	const fields: Record<string, string> = {};
	for (const line of match[1]!.split(/\r?\n/)) {
		const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (field) fields[field[1]!] = field[2]!.replace(/^["']|["']$/g, "").trim();
	}
	return { fields, body: text.slice(match[0].length) };
}

function subdirs(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => !name.startsWith(".") && statSync(join(dir, name)).isDirectory());
	} catch {
		return [];
	}
}

export type Skill = { name: string; description: string; path: string };

/**
 * Agent Skills, as pi finds them: `<dir>/SKILL.md` under the project's `.pi/skills` and `.agents/skills` (nearest
 * directory first) and the user's `~/.pi/agent/skills`. The nearest skill of a name wins. Only the name, description,
 * and location enter the prompt; the agent reads a skill's file when its task matches.
 */
export function loadSkills(cwd: string): Skill[] {
	return cached(skillCache, cwd, () => findSkills(cwd));
}

function findSkills(cwd: string): Skill[] {
	const roots = [...projectDirs(cwd).flatMap((dir) => [join(dir, ".pi", "skills"), join(dir, ".agents", "skills")]), join(agentDir(), "skills")];
	const skills = new Map<string, Skill>();
	for (const root of roots)
		for (const name of subdirs(root)) {
			const path = join(root, name, "SKILL.md");
			if (!existsSync(path)) continue;
			const { fields } = frontmatter(readFileSync(path, "utf8"));
			const skill = { name: fields.name || name, description: (fields.description ?? "").slice(0, MAX_DESCRIPTION), path };
			if (!skills.has(skill.name) && skill.description) skills.set(skill.name, skill);
		}
	return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type PromptTemplate = { name: string; description: string; body: string; path: string };

/** Prompt templates, as pi finds them: `*.md` in the project's `.pi/prompts` (nearest first) and `~/.pi/agent/prompts`. */
export function loadPrompts(cwd: string): PromptTemplate[] {
	return cached(promptCache, cwd, () => findPrompts(cwd));
}

function findPrompts(cwd: string): PromptTemplate[] {
	const roots = [...projectDirs(cwd).map((dir) => join(dir, ".pi", "prompts")), join(agentDir(), "prompts")];
	const prompts = new Map<string, PromptTemplate>();
	for (const root of roots) {
		let names: string[] = [];
		try {
			names = readdirSync(root).filter((name) => name.endsWith(".md"));
		} catch {}
		for (const file of names) {
			const name = file.slice(0, -3);
			if (prompts.has(name)) continue;
			const path = join(root, file);
			const { fields, body } = frontmatter(readFileSync(path, "utf8"));
			prompts.set(name, { name, description: (fields.description ?? body.trim().split("\n")[0]!).slice(0, MAX_DESCRIPTION), body, path });
		}
	}
	return [...prompts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const AmpiCore = defineExtension({
	name: "ampi-core",
	sections: [
		section("preamble", () => PREAMBLE, { tag: false }),
		section("environment", (input) => {
			const cwd = input.env?.cwd ?? input.agent.cwd ?? process.cwd();
			return [`Working directory: ${cwd}`, `Platform: ${process.platform}`, `Host: ${process.env.HOSTNAME ?? ""}`.trim()]
				.filter((line) => !line.endsWith(":"))
				.join("\n");
		}),
		section("project_context", (input) => {
			const cwd = input.env?.cwd ?? input.agent.cwd ?? process.cwd();
			const files = loadContextFiles(cwd);
			if (files.length === 0) return undefined;
			let budget = MAX_CONTEXT_CHARS;
			const parts: string[] = [];
			for (const file of files.reverse()) {
				if (budget <= 0) break;
				const body = file.content.length > budget ? `${file.content.slice(0, budget)}\n[truncated]` : file.content;
				budget -= body.length;
				parts.unshift(`## ${file.path}\n\n${body}`);
			}
			return parts.join("\n\n");
		}),
		section("skills", (input) => {
			const skills = loadSkills(input.env?.cwd ?? input.agent.cwd ?? process.cwd());
			if (skills.length === 0) return undefined;
			return [
				"Skills are task-specific instructions. When a task matches a skill's description, read its file with the read tool first and follow it; paths inside a skill are relative to its directory.",
				...skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")} (${skill.path})`),
			].join("\n");
		}),
	],
});
