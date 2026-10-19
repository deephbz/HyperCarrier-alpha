// One isolated model call on the hub machine (one-gui-views.md §5): no Session, tools, extensions, or context files, the
// hub's own Pi credentials, prompt on stdin. The hub already holds every Session's text as a local copy, so asking here
// moves no text off a machine it was not already on, and works while the Host is away.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AskRequest = { system: string; prompt: string; model?: string; timeoutMs?: number };
export type AskResult = { text: string; model?: string; usage?: { input?: number; output?: number; cost?: number | null } };

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
let running = 0;

/**
 * Runs `pi --mode json --no-session --no-tools …` and returns its final assistant text. `command`, when given, replaces
 * Pi with any argv that reads the prompt on stdin and prints the answer (tests, demos, other carriers). Rejects with
 * `code`: no_model, no_result, model_error, timeout, busy.
 */
export function ask(req: AskRequest, command?: string[]): Promise<AskResult> {
	if (running >= 3) return Promise.reject(fail("busy", "three model calls are already running"));
	const timeoutMs = Math.min(req.timeoutMs ?? 120_000, 600_000);
	const argv = command?.length
		? command
		: [
				process.env.PI_BIN || "pi",
				...["--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--thinking", "off"],
				...(req.model ? ["--model", req.model] : []),
				...["--system-prompt", req.system],
			];
	const scratch = mkdtempSync(join(tmpdir(), "ampi-ask-"));
	running++;
	return new Promise<AskResult>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(argv[0]!, argv.slice(1), { cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
		// SIGTERM first; a child that ignores it is killed 5 s later, so it cannot hold a slot forever.
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		}, timeoutMs);
		const lastLine = () => stderr.trim().split("\n").pop()?.slice(0, 200) ?? "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
		child.on("error", (e: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(fail("no_model", `cannot run ${argv[0]}: ${e.code ?? e.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return reject(fail("timeout", `no answer within ${Math.round(timeoutMs / 1000)} s`));
			if (command?.length) return code === 0 ? resolve({ text: stdout.trim() }) : reject(fail("model_error", lastLine() || `exit ${code}`));
			let final: { stopReason?: string; errorMessage?: string; content?: { type: string; text?: string }[]; provider?: string; model?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined;
			for (const line of stdout.split("\n")) {
				try {
					const record = JSON.parse(line);
					if (record.type === "message_end" && record.message?.role === "assistant") final = record.message;
				} catch {}
			}
			if (!final) return reject(fail("no_result", `pi exited ${code} without an answer${lastLine() ? `: ${lastLine()}` : ""}`));
			if (final.stopReason === "error" || final.stopReason === "aborted") return reject(fail("model_error", String(final.errorMessage ?? final.stopReason).slice(0, 300)));
			resolve({
				text: (final.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"),
				...(final.provider && final.model ? { model: `${final.provider}/${final.model}` } : req.model ? { model: req.model } : {}),
				...(final.usage ? { usage: { input: final.usage.input, output: final.usage.output, cost: final.usage.cost?.total ?? null } } : {}),
			});
		});
		child.stdin.on("error", () => {});
		child.stdin.end(req.prompt);
	}).finally(() => {
		running--;
		rmSync(scratch, { recursive: true, force: true });
	});
}
