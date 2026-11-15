// The AmPi base agent: identity, working rules, and Pi's resource sections for the thread's working directory
// (APPEND_SYSTEM.md, context files, skills), rendered as stable sections so the provider prompt cache stays warm.
// Resources come from pi-config.ts, so a thread and a Pi Session in one directory see the same files; the
// addendum, project_context, and skills sections use Pi's text (test/node-prompt-parity.test.ts compares them).

import { dirname } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { type PiConfigOptions, type PiResources, piResources, type PromptTemplate, type Skill } from "../shared/pi-config.ts";

export { frontmatter, type PromptTemplate, type Skill } from "../shared/pi-config.ts";

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

/** Pi's `<project_context>` body (system-prompt.js renderProjectContext). */
function renderProjectContext(files: PiResources["contextFiles"]): string | undefined {
	if (files.length === 0) return undefined;
	return [
		"Project-specific instructions and guidelines:",
		...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
	].join("\n\n");
}

/** Pi's `<skills>` body: the pinned Pi renders it, for the skills that allow model invocation and the reader hint. */
async function renderSkills(skills: Skill[], tools: string[]): Promise<string | undefined> {
	const reader = tools.includes("read") ? "read" : tools.includes("bash") ? "bash" : undefined;
	if (!reader || skills.length === 0) return undefined;
	// Loaded on first use: Pi's index is heavy, and a node without skills never needs it.
	const { formatSkillsForPrompt } = await import("@earendil-works/pi-coding-agent");
	const piSkills = skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.path,
		baseDir: dirname(skill.path),
		sourceInfo: { path: skill.path, source: "local", scope: "temporary", origin: "top-level" } as const,
		disableModelInvocation: skill.disableModelInvocation ?? false,
	}));
	return formatSkillsForPrompt(piSkills, reader).trim() || undefined;
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
