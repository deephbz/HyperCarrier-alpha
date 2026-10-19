export type PanelSelection = { host: string; threadId: string; teamId?: string };

/** The Timeline panel shows the selected Session and, when it is in a Team, that Team's members. */
export function inPanel(session: { host: string; threadId: string; team?: string }, selected: PanelSelection): boolean {
	return session.host === selected.host && (session.threadId === selected.threadId || Boolean(selected.teamId && session.team === selected.teamId));
}
