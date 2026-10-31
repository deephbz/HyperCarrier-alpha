/**
 * The Timeline row model. Both Team modes render the same groups in the same order:
 *
 *   Sessions ─▶ groups (a Team on its Host, else one Session) ─▶ group order ─▶ per group: one Team row, or its members
 *
 * - Group: one Team lifetime on its Host, else one Session. A Team name can be reused, so each lead Session starts a
 *   lifetime (Team create binds one lead), and a member joins the latest lead that started at or before it, else the
 *   earliest lead. Without a lead the name is one lifetime. Key: `team:<host>/<name>@<lifetime start>`.
 * - Group order: the focused group first, then attention (needs you, then a new answer), then the earliest start, then key.
 *   Every input is a group fact, so the order does not depend on the mode.
 * - Member order: the lead first, then start, then ref.
 * - Merging Team members changes only the rendering inside each Team group, so the rows of other groups keep their order.
 */
export type RowSession = { ref: string; host: string; team?: string; role?: string; start: number; end: number };
export type Group<S extends RowSession> = { key: string; team: boolean; members: S[]; start: number; end: number };
/** One rendered row: a whole group, or one member of an expanded Team group. */
export type Row<S extends RowSession> = { key: string; group: Group<S>; members: S[]; target: S; team: boolean; position?: "first" | "middle" | "last" | "only" };

const byMember = (a: RowSession, b: RowSession) => Number(b.role === "lead") - Number(a.role === "lead") || a.start - b.start || a.ref.localeCompare(b.ref);

export function groupSessions<S extends RowSession>(sessions: S[]): Group<S>[] {
	const teams = new Map<string, S[]>(), groups = new Map<string, S[]>();
	const add = (key: string, s: S) => { const members = groups.get(key) ?? []; members.push(s); groups.set(key, members); };
	for (const s of sessions) if (s.team) { const name = `team:${s.host}/${s.team}`; teams.set(name, [...teams.get(name) ?? [], s]); } else add(s.ref, s);
	for (const [name, members] of teams) {
		const leads = members.filter((s) => s.role === "lead").map((s) => s.start).sort((a, b) => a - b);
		const first = leads[0] ?? Math.min(...members.map((s) => s.start));
		for (const s of members) add(`${name}@${leads.findLast((t) => t <= s.start) ?? first}`, s);
	}
	return [...groups].map(([key, members]) => ({ key, team: key.startsWith("team:"), members: members.sort(byMember),
		start: Math.min(...members.map((s) => s.start)), end: Math.max(...members.map((s) => s.end)) }));
}

/** Sorts groups in place by the documented group order. `rank` reads attention over all members of a group. */
export function orderGroups<S extends RowSession>(groups: Group<S>[], rank: (g: Group<S>) => number, focus?: string | null): Group<S>[] {
	const focused = (g: Group<S>) => Number(Boolean(focus) && g.members.some((s) => s.ref === focus));
	const ranks = new Map(groups.map((g) => [g.key, rank(g)]));
	return groups.sort((a, b) => focused(b) - focused(a) || ranks.get(b.key)! - ranks.get(a.key)! || a.start - b.start || a.key.localeCompare(b.key));
}

/**
 * Rows for ordered groups. `shown` filters Sessions (range, liveness); a group shows when any member shows. A merged
 * Team row carries every member, so its spend stays the Team's; an expanded group lists only its shown members.
 */
export function timelineRows<S extends RowSession>(groups: Group<S>[], merged: boolean, shown: (s: S) => boolean): Row<S>[] {
	return groups.flatMap((group): Row<S>[] => {
		const visible = group.members.filter(shown);
		if (!visible.length) return [];
		if (!group.team || merged) return [{ key: group.key, group, members: group.members, target: group.members[0]!, team: group.team }];
		return visible.map((s, i) => ({ key: s.ref, group, members: [s], target: s, team: false,
			position: visible.length === 1 ? "only" : i === 0 ? "first" : i === visible.length - 1 ? "last" : "middle" }));
	});
}

/** The reader's place: the group at the top of the viewport, the row inside it, and the pixels into that row. */
export type Anchor = { group: string; row: number; px: number };

export function anchorAt(rows: Row<RowSession>[], scrollTop: number, rowHeight: number): Anchor | undefined {
	const index = Math.min(rows.length - 1, Math.max(0, Math.floor(scrollTop / rowHeight)));
	const row = rows[index];
	if (!row) return undefined;
	const first = rows.findIndex((r) => r.group.key === row.group.key);
	return { group: row.group.key, row: index - first, px: scrollTop - index * rowHeight };
}

/** The scroll offset that puts the anchored group back at the same place; undefined when the group left the rows. */
export function scrollFor(rows: Row<RowSession>[], anchor: Anchor, rowHeight: number): number | undefined {
	const first = rows.findIndex((r) => r.group.key === anchor.group);
	if (first < 0) return undefined;
	let last = first;
	while (rows[last + 1]?.group.key === anchor.group) last++;
	return Math.min(last, first + anchor.row) * rowHeight + anchor.px;
}

type Box = Pick<HTMLElement, "getBoundingClientRect" | "closest">;

/** How far the lanes have scrolled under the visible top, in CSS px. A desktop scrolls the lanes in .cos-scroll; a phone
 * scrolls the whole page (cos.css), so the offset comes from whichever of the two clips the lanes. On a phone the sticky
 * axis covers the first lanes under the page top; the render window's three spare rows above the offset cover them. A
 * sticky element above the axis in the page would cover more and needs its height here. The Team toggle's restore adds
 * the offset change to the scroller's scrollTop, so it assumes no zoom root between the scroller and the lanes. */
export function laneOffset(node: Box, lanes: Pick<HTMLElement, "getBoundingClientRect" | "offsetHeight">): number {
	const page = node.closest("main") ?? node;
	const box = lanes.getBoundingClientRect();
	const top = Math.max(node.getBoundingClientRect().top, page.getBoundingClientRect().top);
	// Display zoom scales the client rects; the row height is in CSS px.
	return Math.max(0, (top - box.top) * (box.height ? lanes.offsetHeight / box.height : 1));
}

/** The element that scrolls the lanes now: .cos-scroll when it overflows, else the page. */
export const laneScroller = (node: HTMLElement): HTMLElement => (node.scrollHeight > node.clientHeight ? node : node.closest("main") ?? node);
