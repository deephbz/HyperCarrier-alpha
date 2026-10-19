export const SESSION_SCOPE_MS = 96 * 60 * 60_000;

/** AmPi views include recent Sessions, plus any live or currently open Session. */
export function isSessionInScope(session: { activityAt: number; live?: boolean; open?: boolean }, now = Date.now()): boolean {
	return Boolean(session.live || session.open || session.activityAt >= now - SESSION_SCOPE_MS);
}
