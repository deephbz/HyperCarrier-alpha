// Process-wide counters of background jobs, read by /api/health. Deploy checks use the derive counter to time the
// preview re-derive after a restart; the verify harness waits on both before it counts a step's model calls.
// The module has no imports, so the hub reads it without loading the working set or the views.

/** pending: jobs queued or running. done: jobs settled, ok or failed, since the process started.
 * drainedAt: epoch ms when pending last reached 0; null while jobs run and before the first job. */
export type DeriveQueue = { pending: number; done: number; drainedAt: number | null };

function counter() {
	let pending = 0, done = 0, drainedAt: number | null = null;
	/** Counts one job from its start until `job` settles. */
	function track<T>(job: () => Promise<T>): Promise<T> {
		pending++;
		drainedAt = null;
		const settle = () => {
			pending--; done++;
			if (!pending) drainedAt = Date.now();
		};
		let running: Promise<T>;
		try { running = job(); } catch (error) { running = Promise.reject(error); }
		return running.finally(settle);
	}
	return { track, read: (): DeriveQueue => ({ pending, done, drainedAt }) };
}

const derives = counter(), builds = counter();
/** Session derive jobs (working set). */
export const trackDerive = derives.track, deriveQueue = derives.read;
/** Arc Builds of either trigger (cos.arc). */
export const trackBuild = builds.track, buildQueue = builds.read;
