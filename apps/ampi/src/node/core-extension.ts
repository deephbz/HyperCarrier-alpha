// The AmPi base agent: identity, working rules, and Pi's resource sections for the thread's working directory
// (APPEND_SYSTEM.md, context files, skills), rendered as stable sections so the provider prompt cache stays warm.
// Resources come from pi-config.ts, so a thread and a Pi Session in one directory see the same files; the
// addendum, project_context, and skills sections use Pi's text (test/node-prompt-parity.test.ts compares them).

import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { type PiConfigOptions, type PiResources, piResources, type PromptTemplate, type Skill } from "./pi-config.ts";

export { frontmatter, type PromptTemplate, type Skill } from "./pi-config.ts";

const PREAMBLE = `You are an expert coding agent running inside AmPi, a durable agent harness. You help the user by reading files, running commands, editing code, and writing new files. Your work is committed to durable storage as it happens, so a crash or restart resumes where you stopped.

Rules:
- Read before you edit. Prefer small, exact edits over rewriting whole files.
- Use bash for searching (rg, find), building, and testing. Keep command output focused.
- When the task is done, say plainly what changed and how you verified it. Say when something is not verified.
- Ask the user only when a decision is genuinely theirs; otherwise make a reasonable choice and state it.`;

/** Pi's skill and template discovery for `cwd`; see pi-config.ts. */
export function loadSkills(cwd: string, options: PiConfigOptions = {}): Skill[] {
	return piResources(cwd, options).skills;
}

export function loadPrompts(cwd: string, options: PiConfigOptions = {}): PromptTemplate[] {
	return piResources(cwd, options).prompts;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Pi's `<project_context>` body (system-prompt.js renderProjectContext). */
export function renderProjectContext(files: PiResources["contextFiles"]): string | undefined {
	if (files.length === 0) return undefined;
	return [
		"Project-specific instructions and guidelines:",
		...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
	].join("\n\n");
}

/** Pi's `<skills>` body (skills.js formatSkillsForPrompt): skills that allow model invocation, with the reader hint. */
export function renderSkills(skills: Skill[], tools: string[]): string | undefined {
	const reader = tools.includes("read") ? "read" : tools.includes("bash") ? "bash" : undefined;
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (!reader || visible.length === 0) return undefined;
	return [
		"The following skills provide specialized instructions for specific tasks.",
		reader === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: "Use bash to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
		...visible.flatMap((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.path)}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}

/** The base extension for one node; `options.agentDir` selects the Pi agent directory it reads. */
export function ampiCore(options: PiConfigOptions = {}): Extension {
	const resources = (input: { env?: { cwd?: string }; agent: { cwd?: string } }) =>
		piResources(input.env?.cwd ?? input.agent.cwd ?? process.cwd(), options);
	return defineExtension({
		name: "ampi-core",
		sections: [
			// SYSTEM.md replaces the base prompt, as it replaces Pi's preamble, tools, rules, and docs.
			section("preamble", (input) => resources(input).systemPrompt?.content ?? PREAMBLE, { tag: false }),
			section("addendum", (input) => resources(input).appendSystemPrompt?.content || undefined),
			section("project_context", (input) => renderProjectContext(resources(input).contextFiles)),
			section("skills", (input) => {
				const found = resources(input);
				return renderSkills(found.skills, found.tools);
			}),
			// Last, where Pi renders <cwd>.
			section("environment", (input) => {
				const cwd = input.env?.cwd ?? input.agent.cwd ?? process.cwd();
				return [`Working directory: ${cwd}`, `Platform: ${process.platform}`, `Host: ${process.env.HOSTNAME ?? ""}`.trim()]
					.filter((line) => !line.endsWith(":"))
					.join("\n");
			}),
		],
	});
}

export const AmpiCore = ampiCore();
