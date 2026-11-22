import { WorkingSet } from "../src/pi/working-set.ts";

type RefreshArgs = Parameters<typeof WorkingSet.prototype.refresh>;
type RefreshResult = ReturnType<typeof WorkingSet.prototype.refresh>;
type HeldRefresh = { receiver: WorkingSet; args: RefreshArgs; resolve: (value: Awaited<RefreshResult>) => void; reject: (reason: unknown) => void };

let installed = false;

/** Holds only this cache's refresh calls. Tests use it to expose the provisional-index state deterministically. */
export function holdProseIndex(cacheDir: string): { held: Promise<void>; release(): void; dispose(): void } {
	if (installed) throw new Error("A prose-index hold is already installed");
	installed = true;
	const original = WorkingSet.prototype.refresh;
	const pending: HeldRefresh[] = [];
	let state: "holding" | "released" | "disposed" = "holding";
	let announce!: () => void;
	let failAnnouncement!: (error: Error) => void;
	let announced = false;
	const held = new Promise<void>((resolve, reject) => { announce = resolve; failAnnouncement = reject; });

	function restore() {
		if (WorkingSet.prototype.refresh === replacement) WorkingSet.prototype.refresh = original;
		installed = false;
	}
	function run(call: HeldRefresh) {
		try { void original.apply(call.receiver, call.args).then(call.resolve, call.reject); }
		catch (error) { call.reject(error); }
	}
	function replacement(this: WorkingSet, ...args: RefreshArgs): RefreshResult {
		if (state !== "holding" || this.cacheDir !== cacheDir) return original.apply(this, args);
		if (!announced) { announced = true; announce(); }
		return new Promise((resolve, reject) => pending.push({ receiver: this, args, resolve, reject }));
	}
	WorkingSet.prototype.refresh = replacement;

	return {
		held,
		release() {
			if (state !== "holding") return;
			state = "released";
			restore();
			for (const call of pending.splice(0)) run(call);
		},
		dispose() {
			if (state !== "holding") return;
			state = "disposed";
			restore();
			if (!announced) failAnnouncement(new Error("Prose-index hold disposed before interception"));
			for (const call of pending.splice(0)) call.reject(new Error("Prose-index hold disposed"));
		},
	};
}
