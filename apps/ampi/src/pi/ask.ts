// One isolated model call on the hub machine (one-gui-views.md §5): no Session, tools, extensions, or context files, the
// hub's own Pi credentials, prompt on stdin. The hub already holds every Session's text as a local copy, so asking here
// moves no text off a machine it was not already on, and works while the Host is away.

import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelPurpose, resolveHelperModel } from "../hub/helper-models.ts";
import { piModelRegistry } from "./model-registry.ts";

/** `purpose` picks the helper model (helper-models.ts); `model` is only an owner override typed in a panel. Both
 * resolve against Pi's models to one exact `provider/id`. `resolved` marks a `model` that is already that exact name
 * (from ctx.model), so the call skips the registry. `cache: "long"` asks Pi for the 1 h prompt cache instead of the
 * 5-min default; only a call whose system text the next call repeats within the hour gains from it. */
export type AskRequest = { system: string; prompt: string; purpose?: ModelPurpose; model?: string; resolved?: boolean; timeoutMs?: number; cache?: "long" | "short" };
/** Token counts of one model call, or summed over calls. `input` excludes cached prompt tokens: the prompt is
 * input + cacheRead + cacheWrite. `cost` is null when the model reported no price. `cacheWrite1h`, the part of
 * cacheWrite the provider kept for 1 h, is absent when it kept none. */
export type AskUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; cost: number | null };
export type AskResult = { text: string; model?: string; usage?: AskUsage };

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
let running = 0;

// Pi appends its cwd to the system text, and Anthropic caches the system text as one block. Every call therefore runs
// in one fixed, empty directory: the cached block stays byte-identical across calls and hub restarts, and Pi finds no
// context file there. The name carries the uid only, because the path goes to the provider with every request.
const SCRATCH = /^ampi-ask-[A-Za-z0-9]{6}$/;
const fixedCwd = () => join(tmpdir(), `ampi-ask-cwd-${process.getuid?.() ?? 0}`);

/** The fixed cwd, created when missing; null when it is not this user's own empty, private directory. */
export function askCwd(): string | null {
	const dir = fixedCwd();
	try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null; }
	try {
		const st = lstatSync(dir);
		const own = process.getuid ? st.uid === process.getuid() : true;
		return st.isDirectory() && !st.isSymbolicLink() && own && (st.mode & 0o077) === 0 && readdirSync(dir).length === 0 ? dir : null;
	} catch { return null; }
}

/**
 * Removes per-call prompt directories that an earlier hub left behind (a crash or kill skips its cleanup). Only this
 * user's real directories with the per-call name go, and only after the longest call could have run, so a call of a
 * concurrent hub keeps its own. Returns how many went.
 */
export function sweepAskScratch(now = Date.now()): number {
	let removed = 0;
	let names: string[];
	try { names = readdirSync(tmpdir()); } catch { return 0; }
	for (const name of names) {
		if (!SCRATCH.test(name)) continue;
		const path = join(tmpdir(), name);
		try {
			const st = lstatSync(path);
			if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || now - st.mtimeMs < 2 * MAX_TIMEOUT_MS) continue;
			rmSync(path, { recursive: true, force: true }); removed++;
		} catch {}
	}
	return removed;
}
const MAX_TIMEOUT_MS = 600_000;

/**
 * Whether Pi answered with the requested model. Pi 1.3.0 resolves `--model` fuzzily and turns an unknown id under a
 * known provider into a custom model id with only a warning, so the answer's own provider/model is the proof. A bare
 * requested id matches any provider; a `:thinking` suffix is ignored.
 */
export function sameModel(requested: string, provider: string, model: string): boolean {
	const want = requested.toLowerCase().replace(/:[a-z]+$/, "");
	const got = model.toLowerCase();
	return want.includes("/") ? want === `${provider.toLowerCase()}/${got}` : want === got;
}

/**
 * Runs `pi --mode json --no-session --no-tools …` and returns its final assistant text. `command`, when given, replaces
 * Pi with any argv that reads the prompt on stdin and prints the answer (tests, demos, other carriers). The command
 * gets the model name as AMPI_ASK_MODEL and the system text's file as AMPI_ASK_SYSTEM_FILE, and reports no usage, so
 * its answer names that model. Rejects with
 * `code`: model_not_found (ModelNotFound), registry_unreadable (Pi's model list), no_model (a malformed hub.json
 * entry, Pi does not start), no_result, model_error,
 * timeout, busy. Each failure message starts with the resolved model, and an answer from another model is a
 * model_error, so a wrong or signed-out model never answers silently.
 */
export async function ask(request: AskRequest, command?: string[]): Promise<AskResult> {
	if (running >= 3) throw fail("busy", "three model calls are already running");
	// The slot is taken before the model lookup awaits, so a fourth call cannot pass the check meanwhile.
	running++;
	let req: AskRequest;
	try { req = request.purpose && !(request.resolved && request.model) ? { ...request, model: await resolveHelperModel(request.purpose, request.model, command?.length ? undefined : piModelRegistry) } : request; }
	catch (e) { running--; throw (e as { code?: string }).code ? e : fail("no_model", (e as Error).message); }
	return run(req, command);
}

function run(req: AskRequest, command?: string[]): Promise<AskResult> {
	// A resolved helper model is Pi's exact provider/id; naming the provider apart keeps Pi from a fuzzy lookup.
	const slash = req.model?.indexOf("/") ?? -1;
	const modelArgs = !req.model ? [] : req.purpose && slash > 0 ? ["--provider", req.model.slice(0, slash), "--model", req.model.slice(slash + 1)] : ["--model", req.model];
	const timeoutMs = Math.min(req.timeoutMs ?? 120_000, MAX_TIMEOUT_MS);
	// The system text goes by file: Pi reads a --system-prompt that names an existing file, and a 200k-token Arc
	// prefix would pass the argv limit. The file sits in a private per-call directory, apart from the fixed cwd.
	let scratch = "";
	const systemFile = () => join(scratch, "system.txt");
	try {
		scratch = mkdtempSync(join(tmpdir(), "ampi-ask-"));
		writeFileSync(systemFile(), req.system, { mode: 0o600 });
	} catch (e) { running--; if (scratch) rmSync(scratch, { recursive: true, force: true }); return Promise.reject(e); }
	const argv = command?.length
		? command
		: [
				process.env.PI_BIN || "pi",
				...["--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--thinking", "off"],
				...modelArgs,
				...["--system-prompt", systemFile()],
			];
	return new Promise<AskResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const env = { ...process.env, ...(command?.length ? { AMPI_ASK_SYSTEM_FILE: systemFile(), ...(req.model ? { AMPI_ASK_MODEL: req.model } : {}) } : {}), ...(req.cache === "long" ? { PI_CACHE_RETENTION: "long" } : {}) };
		const child = spawn(argv[0]!, argv.slice(1), { cwd: askCwd() ?? scratch, env, stdio: ["pipe", "pipe", "pipe"] });
		// SIGTERM first; a child that ignores it is killed 5 s later, so it cannot hold a slot forever.
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		}, timeoutMs);
		const lastLine = () => stderr.trim().split("\n").pop()?.slice(0, 200) ?? "";
		const who = req.model ? `${req.model}: ` : "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
		child.on("error", (e: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(fail("no_model", `${who}cannot run ${argv[0]}: ${e.code ?? e.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return reject(fail("timeout", `${who}no answer within ${Math.round(timeoutMs / 1000)} s`));
			if (command?.length) return code === 0 ? resolve({ text: stdout.trim(), ...(req.model ? { model: req.model } : {}) }) : reject(fail("model_error", `${who}${lastLine() || `exit ${code}`}`));
			let final: { stopReason?: string; errorMessage?: string; content?: { type: string; text?: string }[]; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cost?: { total?: number } } } | undefined;
			for (const line of stdout.split("\n")) {
				try {
					const record = JSON.parse(line);
					if (record.type === "message_end" && record.message?.role === "assistant") final = record.message;
				} catch {}
			}
			if (!final) return reject(fail("no_result", `${who}pi exited ${code} without an answer${lastLine() ? `: ${lastLine()}` : ""}`));
			if (final.stopReason === "error" || final.stopReason === "aborted") return reject(fail("model_error", `${who}${String(final.errorMessage ?? final.stopReason).slice(0, 300)}`));
			if (req.model && final.provider && final.model && !sameModel(req.model, final.provider, final.model)) return reject(fail("model_error", `${req.model} was requested, but ${final.provider}/${final.model} answered. Check the model id and Pi sign-in on the hub.`));
			resolve({
				text: (final.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"),
				...(final.provider && final.model ? { model: `${final.provider}/${final.model}` } : req.model ? { model: req.model } : {}),
				...(final.usage ? { usage: { input: final.usage.input ?? 0, output: final.usage.output ?? 0, cacheRead: final.usage.cacheRead ?? 0, cacheWrite: final.usage.cacheWrite ?? 0, ...(final.usage.cacheWrite1h ? { cacheWrite1h: final.usage.cacheWrite1h } : {}), cost: final.usage.cost?.total ?? null } } : {}),
			});
		});
		child.stdin.on("error", () => {});
		child.stdin.end(req.prompt);
	}).finally(() => {
		running--;
		rmSync(scratch, { recursive: true, force: true });
	});
}
