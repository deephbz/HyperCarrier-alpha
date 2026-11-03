// The hub's global config file, its one writer, and the helper models it names. Helper models answer the hub's own
// isolated Rarebit side asks; each Pi Session keeps the model that Pi chose for it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ampiHome } from "../shared/home.ts";
import { dirname, join } from "node:path";

export function hubConfigPath(): string {
	return process.env.AMPI_HUB_CONFIG ?? join(ampiHome(), "hub.json");
}

/** Rarebit side asks use the hub's explicit helper model. Arc reads Pi settings separately. */
export type ModelPurpose = "rarebitAsk";
export type HelperModels = Partial<Record<ModelPurpose, string>>;
const PURPOSES: readonly ModelPurpose[] = ["rarebitAsk"];
let configFile: string | undefined, configModels: unknown;
export function useHubConfig(path: string | undefined, models?: unknown): void {
 configFile = path; configModels = path ? undefined : models;
}

/** Where a helper model name came from, so an error can say where to change it. `unset`: no key names a model. */
export type ModelSource = { kind: "call" } | { kind: "file" | "unset"; key: string; file: string };
type Named = { name: string | null; source: ModelSource; stale: string[] };

/**
 * The configured model name for one helper call: the explicit per-call model, else hub.json
 * `models.<purpose>`. There is no built-in default: with no key set the name is
 * null. hub.json is read on every call, so an edit applies to the next call without a hub restart. A malformed file
 * or entry throws with its path.
 */
function namedModel(purpose: ModelPurpose, explicit: unknown, path: string | undefined): Named {
	const file = path ?? (configModels ? "the hub's config" : "hub.json");
	if (typeof explicit === "string" && explicit.trim()) return { name: explicit.trim(), source: { kind: "call" }, stale: [] };
	let models: unknown = path ? undefined : configModels;
	if (path && existsSync(path)) {
		try { models = (JSON.parse(readFileSync(path, "utf8")) as { models?: unknown }).models; }
		catch (e) { throw noModel(`${path} is not valid JSON: ${(e as Error).message}`); }
	}
	const entry = (key: string) => {
		const v = models && typeof models === "object" ? (models as Record<string, unknown>)[key] : undefined;
		if (v !== undefined && (typeof v !== "string" || !v.trim())) throw noModel(`${path}: models.${key} must be a provider/model-id string from pi --list-models`);
		return (v as string | undefined)?.trim();
	};
	const stale = staleNotes(models, file);
	warnStale(stale);
	const own = entry(purpose);
	if (own) return { name: own, source: { kind: "file", key: purpose, file }, stale };
	return { name: null, source: { kind: "unset", key: purpose, file }, stale };
}

const noModel = (message: string) => Object.assign(new Error(message), { code: "no_model" });

/** Unknown helper settings. An unset key's error repeats them, so an owner who set a wrong name learns why it has no effect. */
function staleNotes(models: unknown, file: string): string[] {
	const notes: string[] = [];
	for (const key of models && typeof models === "object" ? Object.keys(models) : []) {
		if (!key.startsWith("arc") && !PURPOSES.includes(key as ModelPurpose)) notes.push(`models.${key} is not a model key; use models.${PURPOSES.join(", models.")}.`);
	}
	return notes;
}

// The hub log names each note once until the notes change, though hub.json is read on every call.
let warned = "";
function warnStale(notes: string[]): void {
	const said = notes.join("\n");
	if (said && said !== warned) for (const n of notes) console.warn(`ampi hub: ${n}`);
	warned = said;
}

const PURPOSE_WORDS: Record<ModelPurpose, string> = { rarebitAsk: "Rarebit ask" };
const purposeWords = (ps: ModelPurpose[]) => ps.map((p) => PURPOSE_WORDS[p]).join(" and ");
const SOURCE_WORDS = (s: ModelSource) => s.kind === "call" ? "per-call model" : "hub.json";
const SOURCE_FIX = (s: ModelSource, keys = [s.kind === "file" || s.kind === "unset" ? s.key : ""]) => s.kind === "call" ? "Change or clear the per-call model." : `${s.kind === "unset" ? "Set" : "Edit"} models.${keys.join(" and models.")} in ${s.file}.`;

/**
 * One configured name that names no model the carrier lists, or no name at all (`model` null), for `purposes`.
 * `exact` are the carrier's `provider/id` rows for the same model id, such as anthropic/claude-haiku-5-5 for a bare
 * claude-haiku-5-5; they are suggestions only and are never used in its place. `stale` names settings the hub
 * does not read (staleNotes), for an unset key.
 */
export type ModelMiss = { purposes: ModelPurpose[]; model: string | null; source: ModelSource; exact: string[]; stale?: string[] };
/** How many `available` rows a message lists before "+N more"; a panel lists the rest on request. */
export const AVAILABLE_SHOWN = 12;
const missSummary = (m: ModelMiss) => m.model === null ? `No model set for ${purposeWords(m.purposes)}.` : `No model named ${m.model} (${SOURCE_WORDS(m.source)}, ${purposeWords(m.purposes)}).`;
const missHint = (m: ModelMiss) => [SOURCE_FIX(m.source, m.source.kind === "unset" ? m.purposes : undefined), ...(m.exact.length ? [`Try: ${m.exact.slice(0, 5).join(", ")}.`] : []), ...(m.stale ?? [])];
/** "Available: a, b, …, +N more." over every registry row, or where to find the rows when no registry was read. */
export function availableText(available: string[] | undefined): string {
	if (!available) return "Use a provider/model-id from pi --list-models on the hub.";
	if (!available.length) return "Pi lists no usable model; sign in to a provider on the hub.";
	const more = available.length - AVAILABLE_SHOWN;
	return `Available: ${available.slice(0, AVAILABLE_SHOWN).join(", ")}${more > 0 ? `, +${more} more` : ""}.`;
}

/**
 * Helper model names that name no model the carrier can use, or keys that name none. `summary` says which names
 * failed, where each came from, and for which purposes; `hint` says where to set each and ends with availableText.
 * The message is both. `available` holds every `provider/id` row the registry listed, sorted, or is absent when no
 * registry was read. `purpose` and `model` describe the first miss.
 */
export class ModelNotFound extends Error {
	readonly code = "model_not_found";
	readonly misses: ModelMiss[];
	readonly purpose: ModelPurpose;
	readonly model: string | null;
	readonly summary: string;
	readonly hint: string;
	readonly available?: string[];
	constructor(misses: ModelMiss[], available?: string[]) {
		const summary = misses.map(missSummary).join(" ");
		// One stale note per error, however many misses repeat it.
		const hint = [...new Set(misses.flatMap(missHint)), availableText(available)].join(" ");
		super(`${summary} ${hint}`);
		this.name = "ModelNotFound"; this.misses = misses; this.purpose = misses[0]!.purposes[0]!; this.model = misses[0]!.model;
		this.summary = summary; this.hint = hint;
		if (available) this.available = available;
	}

}

/** One model a carrier can use now, such as a row of `pi --list-models`. */
export type CarrierModel = { provider: string; id: string };

/** The models a carrier can use now. `fresh` asks for a new read instead of a cached one. src/pi/model-registry.ts is Pi's. */
export type ModelRegistry = { list(fresh: boolean): Promise<CarrierModel[]> };

/**
 * The model name for one helper call, as configured (`namedModel`). It must equal a `provider/id` row of the
 * registry exactly; there is no short name, alias, default or tie-break. A miss reads the registry once more, so a
 * new sign-in counts, then throws ModelNotFound with every row as `available`. Concurrent misses share one fresh read
 * (model-registry.ts). Without a registry (tests, demos, ask commands) a configured name is used as written. An unset
 * key throws before any registry read.
 */
export async function resolveHelperModel(purpose: ModelPurpose, explicit?: unknown, registry?: ModelRegistry): Promise<string> {
	const { name, source, stale } = namedModel(purpose, explicit, configFile);
	const full = (m: CarrierModel) => `${m.provider}/${m.id}`;
	// An unset key fails at config read: no registry read, so the error says where to find the rows.
	if (name === null) throw new ModelNotFound([{ purposes: [purpose], model: null, source, exact: [], stale }]);
	if (!registry) return name;
	let rows = await registry.list(false);
	if (!rows.some((m) => full(m) === name)) rows = await registry.list(true);
	if (rows.some((m) => full(m) === name)) return name;
	// Suggestions are rows for the same model id: for claude-haiku-5-5 or magpie/claude/claude-haiku-5-5, rows such
	// as anthropic/claude-haiku-5-5 whose id is that last segment or ends with "/" and it.
	const last = name.split("/").pop()!;
	const exact = rows.filter((m) => m.id === last || m.id.endsWith(`/${last}`)).map(full);
	throw new ModelNotFound([{ purposes: [purpose], model: name, source, exact }], rows.map(full).sort());
}

/** The configured model name for one helper call, or null when no key names one; see resolveHelperModel. */
export function helperModel(purpose: ModelPurpose, explicit?: unknown, path = configFile): string | null {
	return namedModel(purpose, explicit, path).name;
}

/**
 * The only code that writes hub.json. The owner edits the file while the hub runs, so a Host change re-reads the
 * current file, replaces only `hosts`, keeps every other key, and swaps the file in with a rename. A file that is not
 * a valid JSON object fails the change with its path and is never rewritten.
 */
export function updateHubHosts<H>(path: string, change: (hosts: H[]) => H[]): void {
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		let parsed: unknown;
		try { parsed = JSON.parse(readFileSync(path, "utf8")); }
		catch (e) { throw new Error(`${path} is not valid JSON: ${(e as Error).message}`); }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must hold a JSON object`);
		config = parsed as Record<string, unknown>;
	}
	if (config.hosts !== undefined && !Array.isArray(config.hosts)) throw new Error(`${path}: hosts must be a list`);
	config.hosts = change((config.hosts as H[] | undefined) ?? []);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const next = `${path}.${process.pid}.tmp`;
	writeFileSync(next, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(next, path);
}
