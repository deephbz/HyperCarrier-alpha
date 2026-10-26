// The Worker model-role catalog: `pi_team_bright.model_roles` and `default_model_role` from the global and the trusted
// project settings, resolved by Pi Team Bright's rules (packages/pi-team-bright/src/utils/model-role-settings.ts):
// a project role replaces the global role of its name, an invalid project role hides it, the project's
// `default_model_role` wins when the project sets one, and a default that names no valid role is invalid.
// The Team plugin receives this port in hydrate(); it never reads settings files itself.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { piResources, type PiConfigOptions } from "./pi-config.ts";

/** One selectable role, in durable-team's `ModelRole` shape. */
export type ModelRole = { name: string; use: string; model: { provider: string; modelId: string }; thinking: string };

export type ModelRoleCatalog = {
	/** Valid roles, global first, then the project's, each name once. */
	roles: ModelRole[];
	defaultRole?: string;
	/** True when `defaultRole` is set but invalid, or a settings file holding roles is unreadable. */
	invalidDefault: boolean;
	/** Configured role names that cannot be selected, with the reason in `diagnostics`. */
	invalid: string[];
	diagnostics: { source: "global" | "project"; path: string; message: string }[];
};

export type ModelRolePort = { modelRoles(cwd: string): ModelRoleCatalog };

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ROLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MODEL_REF = /^[^/\s]+\/[^\s]+$/;

type Parsed = { roles: Map<string, ModelRole>; invalid: Set<string>; hasDefault: boolean; defaultRole?: string; invalidDefault: boolean; broken: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(file: string, source: "global" | "project", diagnostics: ModelRoleCatalog["diagnostics"]): Parsed {
	const parsed: Parsed = { roles: new Map(), invalid: new Set(), hasDefault: false, invalidDefault: false, broken: false };
	const fail = (path: string, message: string) => diagnostics.push({ source, path, message });
	let root: unknown;
	try {
		root = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return parsed;
		fail("pi_team_bright", `${file} cannot be read as JSON`);
		return { ...parsed, hasDefault: true, invalidDefault: true, broken: true };
	}
	if (!isRecord(root) || !("pi_team_bright" in root)) return parsed;
	const namespace = root.pi_team_bright;
	if (!isRecord(namespace)) {
		fail("pi_team_bright", "pi_team_bright must be an object");
		return { ...parsed, hasDefault: true, invalidDefault: true, broken: true };
	}
	if ("model_roles" in namespace) {
		if (!isRecord(namespace.model_roles)) {
			fail("pi_team_bright.model_roles", "model_roles must map names to roles");
			parsed.broken = true;
		} else
			for (const [name, raw] of Object.entries(namespace.model_roles)) {
				const valid =
					ROLE_NAME.test(name) &&
					isRecord(raw) &&
					Object.keys(raw).every((key) => key === "model" || key === "thinking" || key === "use") &&
					typeof raw.model === "string" &&
					MODEL_REF.test(raw.model) &&
					typeof raw.thinking === "string" &&
					THINKING.includes(raw.thinking) &&
					typeof raw.use === "string" &&
					raw.use.trim() !== "";
				if (!valid) {
					fail(`pi_team_bright.model_roles.${name}`, "a role needs a qualified model, a thinking level, and a nonempty use");
					parsed.invalid.add(name);
					continue;
				}
				const model = raw.model as string;
				const slash = model.indexOf("/");
				parsed.roles.set(name, {
					name,
					use: (raw.use as string).trim(),
					model: { provider: model.slice(0, slash), modelId: model.slice(slash + 1) },
					thinking: raw.thinking as string,
				});
			}
	}
	if ("default_model_role" in namespace) {
		parsed.hasDefault = true;
		if (typeof namespace.default_model_role === "string" && ROLE_NAME.test(namespace.default_model_role)) parsed.defaultRole = namespace.default_model_role;
		else {
			fail("pi_team_bright.default_model_role", "default_model_role must name one model role");
			parsed.invalidDefault = true;
		}
	}
	return parsed;
}

export function readModelRoles(cwd: string, options: PiConfigOptions = {}): ModelRoleCatalog {
	const resources = piResources(cwd, options);
	const diagnostics: ModelRoleCatalog["diagnostics"] = [];
	const global = parse(join(resources.agentDir, "settings.json"), "global", diagnostics);
	const project = resources.trust === "trusted" ? parse(join(resources.cwd, ".pi", "settings.json"), "project", diagnostics) : undefined;
	const roles = new Map(global.broken ? [] : global.roles);
	const invalid = new Set(global.invalid);
	if (project) {
		for (const name of project.invalid) {
			roles.delete(name);
			invalid.add(name);
		}
		for (const [name, role] of project.roles) {
			roles.set(name, role);
			invalid.delete(name);
		}
		if (project.broken) roles.clear();
	}
	const selected = project?.hasDefault ? project : global;
	let invalidDefault = selected.invalidDefault;
	if (selected.defaultRole && !roles.has(selected.defaultRole)) {
		diagnostics.push({ source: selected === project ? "project" : "global", path: "pi_team_bright.default_model_role", message: `default model role '${selected.defaultRole}' has no valid definition` });
		invalidDefault = true;
	}
	return { roles: [...roles.values()], ...(selected.defaultRole ? { defaultRole: selected.defaultRole } : {}), invalidDefault, invalid: [...invalid], diagnostics };
}

export function modelRolePort(options: PiConfigOptions = {}): ModelRolePort {
	return { modelRoles: (cwd) => readModelRoles(cwd, options) };
}
