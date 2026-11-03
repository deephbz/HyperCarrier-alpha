// Shared isolated Pi CLI mechanics. Callers own admission, model choice and durable execution records.
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export type PiCallRequest = { system: string; prompt: string; purpose?: string; model?: string; resolved?: boolean; timeoutMs?: number; cache?: "long" | "short"; maxOutputTokens?: number };
export type PiCallUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; cost: number | null };
export type PiCallResult = { text: string; model?: string; usage?: PiCallUsage; truncated?: boolean };
export type PiCallLifecycle = { env?: NodeJS.ProcessEnv; extensionPath?: string; started?(pid: number): void | Promise<void>; exited?(): void };
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

// Pi appends its cwd to the system text, and Anthropic caches the system text as one block. Every call therefore runs
// in one fixed, empty directory: the cached block stays byte-identical across calls and hub restarts, and Pi finds no
// context file there. The name carries the uid only, because the path goes to the provider with every request.
const SCRATCH = /^ampi-ask-[A-Za-z0-9]{6}$/;
const fixedCwd = () => join(tmpdir(), `ampi-ask-cwd-${process.getuid?.() ?? 0}`);

/** The fixed cwd, created when missing; null when it is not this user's own empty, private directory. */
function askCwd(): string | null {
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
function sameModel(requested: string, provider: string, model: string): boolean {
	const want = requested.toLowerCase().replace(/:[a-z]+$/, "");
	const got = model.toLowerCase();
	return want.includes("/") ? want === `${provider.toLowerCase()}/${got}` : want === got;
}

export function runPiCall(req: PiCallRequest, command?: string[], lifecycle: PiCallLifecycle = {}): Promise<PiCallResult> {
	// A resolved helper model is Pi's exact provider/id; naming the provider apart keeps Pi from a fuzzy lookup.
	const slash = req.model?.indexOf("/") ?? -1;
	const modelArgs = !req.model ? [] : (req.purpose || req.resolved) && slash > 0 ? ["--provider", req.model.slice(0, slash), "--model", req.model.slice(slash + 1)] : ["--model", req.model];
	const timeoutMs = Math.min(req.timeoutMs ?? 120_000, MAX_TIMEOUT_MS);
	// The system text goes by file: Pi reads a --system-prompt that names an existing file, and a 200k-token Arc
	// prefix would pass the argv limit. The file sits in a private per-call directory, apart from the fixed cwd.
	let scratch = "";
	const systemFile = () => join(scratch, "system.txt");
	try {
		scratch = mkdtempSync(join(tmpdir(), "ampi-ask-"));
		writeFileSync(systemFile(), req.system, { mode: 0o600 });
	} catch (e) { if (scratch) rmSync(scratch, { recursive: true, force: true }); return Promise.reject(e); }
	const argv = command?.length
		? command
		: [
				lifecycle.env?.PI_BIN || process.env.PI_BIN || "pi",
				...["--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--thinking", "off"],
				...modelArgs,
				...(req.maxOutputTokens ? ["--extension", lifecycle.extensionPath ?? fileURLToPath(new URL("./ask-limit.ts", import.meta.url))] : []),
				...["--system-prompt", systemFile()],
			];
	return new Promise<PiCallResult>((resolve, reject) => {
		let dispatched = false, closed = false;
		let startupError: unknown;
		const refuse = (e: Error) => reject(Object.assign(e, { dispatched }));
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const env = { ...process.env, ...lifecycle.env, ...(req.maxOutputTokens ? { AMPI_ASK_OUTPUT_TOKENS: String(req.maxOutputTokens) } : {}), ...(command?.length ? { AMPI_ASK_SYSTEM_FILE: systemFile(), ...(req.model ? { AMPI_ASK_MODEL: req.model } : {}) } : {}), ...(req.cache === "long" ? { PI_CACHE_RETENTION: "long" } : {}) };
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
			refuse(fail("no_model", `${who}cannot run ${argv[0]}: ${e.code ?? e.message}`));
		});
		child.on("close", (code) => {
			closed = true;
			clearTimeout(timer);
			try { lifecycle.exited?.(); } catch (e) { return refuse(e as Error); }
			if (startupError) return refuse(startupError as Error);
			if (command?.length && timedOut) return refuse(fail("timeout", `${who}no answer within ${Math.round(timeoutMs / 1000)} s`));
			if (command?.length) return code === 0 ? resolve({ text: stdout.trim(), ...(req.model ? { model: req.model } : {}) }) : refuse(fail("model_error", `${who}${lastLine() || `exit ${code}`}`));
			let final: { stopReason?: string; errorMessage?: string; resetAt?: number | string; content?: { type: string; text?: string }[]; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cost?: { total?: number } } } | undefined;
			for (const line of stdout.split("\n")) {
				try {
					const record = JSON.parse(line);
					if (record.type === "message_end" && record.message?.role === "assistant") final = record.message;
				} catch {}
			}
			const usage = final?.usage ? { input: final.usage.input ?? 0, output: final.usage.output ?? 0, cacheRead: final.usage.cacheRead ?? 0, cacheWrite: final.usage.cacheWrite ?? 0, ...(final.usage.cacheWrite1h ? { cacheWrite1h: final.usage.cacheWrite1h } : {}), cost: final.usage.cost?.total ?? null } : undefined;
			if (timedOut) return refuse(Object.assign(fail("timeout", `${who}no answer within ${Math.round(timeoutMs / 1000)} s`), { usage }));
			if (!final) return refuse(fail("no_result", `${who}pi exited ${code} without an answer${lastLine() ? `: ${lastLine()}` : ""}`));
			if (final.stopReason === "error" || final.stopReason === "aborted") return refuse(Object.assign(fail("model_error", `${who}${String(final.errorMessage ?? final.stopReason).slice(0, 300)}`), { usage, ...(final.resetAt !== undefined ? { resetAt: final.resetAt } : {}) }));
			if (req.model && (req.resolved ? !final.provider || !final.model || req.model !== `${final.provider}/${final.model}` : final.provider && final.model && !sameModel(req.model, final.provider, final.model))) return refuse(Object.assign(fail("model_error", `${req.model} was requested, but ${final.provider ?? "unknown"}/${final.model ?? "unknown"} answered. Check the model id and Pi sign-in.`), { usage, modelMismatch: true }));
			resolve({
				...(final.stopReason === "length" ? { truncated: true } : {}),
				text: (final.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"),
				...(final.provider && final.model ? { model: `${final.provider}/${final.model}` } : req.model ? { model: req.model } : {}),
				...(usage ? { usage } : {}),
			});
		});
		child.stdin.on("error", () => {});
		child.once("spawn", () => {
			Promise.resolve().then(() => lifecycle.started?.(child.pid!)).then(() => {
				if (!closed && !timedOut && child.exitCode === null) { dispatched = true; child.stdin.end(req.prompt); }
			}).catch(e => { startupError = e; child.kill("SIGKILL"); });
		});
	}).finally(() => {
		rmSync(scratch, { recursive: true, force: true });
	});
}
