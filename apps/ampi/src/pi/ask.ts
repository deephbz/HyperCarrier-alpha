// One isolated model call on the hub machine (one-gui-views.md §5): no Session, tools or user extensions/context files; the
// hub's own Pi credentials, prompt on stdin. The hub already holds every Session's text as a local copy, so asking here
// moves no text off a machine it was not already on, and works while the Host is away.

import { runPiCall, type PiCallResult } from "./isolated-call.ts";
export { sweepAskScratch } from "./isolated-call.ts";
import { type ModelPurpose, resolveHelperModel } from "../hub/helper-models.ts";
import { piModelRegistry } from "./model-registry.ts";

/** `purpose` picks the helper model (helper-models.ts); `model` is only an owner override typed in a panel. Both
 * resolve against Pi's models to one exact `provider/id`. `resolved` marks a `model` that is already that exact name
 * (from ctx.model), so the call skips the registry. `cache: "long"` asks Pi for the 1 h prompt cache instead of the
 * 5-min default; only a call whose system text the next call repeats within the hour gains from it. */
export type AskRequest = { system: string; prompt: string; purpose?: ModelPurpose; model?: string; resolved?: boolean; timeoutMs?: number; cache?: "long" | "short"; admission?: "background" | "interactive"; waitMs?: number; onWait?: (waiting: boolean) => void; maxOutputTokens?: number };
export type AskResult = PiCallResult;

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
/**
 * Hub-wide model-call capacity. Each call starts one Pi process. Background calls (Arc Builds) may hold all slots
 * but one, so an interactive call such as a Rarebit Ask always finds a slot unless other interactive calls hold it.
 */
export const ASK_CONCURRENCY = 8, BACKGROUND_CONCURRENCY = ASK_CONCURRENCY - 1;
let running = 0, background = 0;

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
	const deadline = Date.now() + (request.waitMs ?? 0);
	// `onWait(true)` reports a wait for a slot once; `onWait(false)` reports admission after that wait. The slot is taken
	// before the callback runs, and a throwing callback cannot change admission.
	let waited = false;
	while (running >= ASK_CONCURRENCY || request.admission === "background" && background >= BACKGROUND_CONCURRENCY) {
		if (Date.now() >= deadline) throw fail("busy", "Model-call capacity is busy. Retry shortly.");
		if (!waited) { waited = true; try { request.onWait?.(true); } catch {} }
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	running++; if (request.admission === "background") background++;
	if (waited) try { request.onWait?.(false); } catch {}
	let req: AskRequest;
	try { req = request.purpose && !(request.resolved && request.model) ? { ...request, model: await resolveHelperModel(request.purpose, request.model, command?.length ? undefined : piModelRegistry) } : request; }
	catch (e) { running--; if (request.admission === "background") background--; throw (e as { code?: string }).code ? e : fail("no_model", (e as Error).message); }
	return runPiCall(req, command).finally(() => { running--; if (request.admission === "background") background--; });
}
