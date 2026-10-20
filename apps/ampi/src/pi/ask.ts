// One isolated model call on the hub machine (one-gui-views.md §5): no Session, tools, extensions, or context files, the
// hub's own Pi credentials, prompt on stdin. The hub already holds every Session's text as a local copy, so asking here
// moves no text off a machine it was not already on, and works while the Host is away.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelPurpose, resolveHelperModel } from "../hub/helper-models.ts";
import { piModelRegistry } from "./model-registry.ts";

/** `purpose` picks the helper model (helper-models.ts); `model` is only an owner override typed in a panel. Both
 * resolve against Pi's models to one exact `provider/id`. `resolved` marks a `model` that is already that exact name
 * (from ctx.model), so the call skips the registry. */
export type AskRequest = { system: string; prompt: string; purpose?: ModelPurpose; model?: string; resolved?: boolean; timeoutMs?: number };
/** Token counts of one model call, or summed over calls. `input` excludes cached prompt tokens: the prompt is
 * input + cacheRead + cacheWrite. `cost` is null when the model reported no price. */
export type AskUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null };
export type AskResult = { text: string; model?: string; usage?: AskUsage };

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
let running = 0;

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
 * gets the model name as AMPI_ASK_MODEL and reports no usage, so its answer names that model. Rejects with
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
	const timeoutMs = Math.min(req.timeoutMs ?? 120_000, 600_000);
	const argv = command?.length
		? command
		: [
				process.env.PI_BIN || "pi",
				...["--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--thinking", "off"],
				...modelArgs,
				...["--system-prompt", req.system],
			];
	let scratch: string;
	try { scratch = mkdtempSync(join(tmpdir(), "ampi-ask-")); }
	catch (e) { running--; return Promise.reject(e); }
	return new Promise<AskResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const env = command?.length && req.model ? { ...process.env, AMPI_ASK_MODEL: req.model } : process.env;
		const child = spawn(argv[0]!, argv.slice(1), { cwd: scratch, env, stdio: ["pipe", "pipe", "pipe"] });
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
			let final: { stopReason?: string; errorMessage?: string; content?: { type: string; text?: string }[]; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } | undefined;
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
				...(final.usage ? { usage: { input: final.usage.input ?? 0, output: final.usage.output ?? 0, cacheRead: final.usage.cacheRead ?? 0, cacheWrite: final.usage.cacheWrite ?? 0, cost: final.usage.cost?.total ?? null } } : {}),
			});
		});
		child.stdin.on("error", () => {});
		child.stdin.end(req.prompt);
	}).finally(() => {
		running--;
		rmSync(scratch, { recursive: true, force: true });
	});
}
