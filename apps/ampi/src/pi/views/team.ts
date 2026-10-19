import type { PiView, PiViewContext } from "./types.ts";

export type PiTeamTask = { id: string; title: string; status: string; owner?: string; deps: string[]; ready: boolean; updatedAt?: string };
type RecordedMember = { team: string; member: string; role: string; session?: string; pane?: string };
type TeamFrame = { status?: string; codes?: string[]; recorded?: RecordedMember[]; tasks?: Record<string, { availability: string; tasks: PiTeamTask[]; issues: string[] }> };

export type TeamValue = {
	availability: string;
	teams: { name: string; members: { member: string; role: string; threadId?: string; ref?: string; pane?: string; live: boolean; status: string }[]; tasks: PiTeamTask[]; issues: string[] }[];
};

function project(ctx: PiViewContext, snapshot: TeamFrame, threadId?: string): TeamValue {
	const sessions = ctx.sessions();
	const byPath = new Map(sessions.map(s => [s.path, s]));
	const path = threadId ? ctx.session(threadId)?.path : undefined;
	const joinedTeam = threadId ? ctx.session(threadId)?.summary?.team?.teamId : undefined;
	const recorded = snapshot.recorded ?? ctx.teams();
	const names = new Set([...recorded.map(m => m.team), ...Object.keys(snapshot.tasks ?? {})]);
	const groups = [...names].filter(name => !threadId || name === joinedTeam || (path && recorded.some(m => m.team === name && m.session === path)));
	return {
		availability: snapshot.status ?? "loading",
		teams: groups.map(name => ({
			name,
			members: recorded.filter(m => m.team === name).map(member => {
				const session = member.session ? byPath.get(member.session) : undefined;
				const summary = session?.summary;
				const live = summary?.live === true;
				return { member: member.member, role: member.role, ...(session ? { threadId: session.threadId, ref: session.ref } : {}),
					...(member.pane ? { pane: member.pane } : {}), live,
					status: !live ? "not running" : summary?.attention?.some(a => a.source === "Herdr") ? "needs you" : summary?.activity === "idle" ? "idle" : summary?.activity ?? "running" };
			}),
			tasks: snapshot.tasks?.[name]?.availability === "available" ? snapshot.tasks[name]!.tasks : [],
			issues: [...new Set([...(snapshot.codes ?? []), ...(snapshot.tasks?.[name]?.issues ?? ["task_reader_missing"]), ...(snapshot.tasks?.[name]?.availability === "unavailable" ? ["task_authority_unavailable"] : [])])],
		})),
	};
}

export const teamView: PiView = {
	name: "team",
	scope: "any",
	value: (ctx, topic) => project(ctx, ctx.teamsFrame() ?? {}, topic.threadId),
};
