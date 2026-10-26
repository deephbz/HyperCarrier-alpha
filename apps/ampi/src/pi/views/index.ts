// Views a Pi Host serves. One line per view; each lives in its own file and owns its own tests.

import type { OpHandlers, ViewOps } from "../../shared/protocol.ts";
import { rarebitView } from "./rarebit.ts";
import { teamView } from "./team.ts";
import type { HostedView, PiViewContext, PiViews } from "./types.ts";
import { cosTimeline } from "./cos-timeline.ts";
import { cosArc } from "./cos-arc.ts";

export const VIEWS: PiViews = { rarebit: rarebitView, team: teamView, "cos.timeline": cosTimeline, "cos.arc": cosArc };
export const PI_VIEWS: HostedView[] = Object.values(VIEWS);

/** Every view op under its request name. The mapped type makes this table and `ViewTopics` agree key for key. */
export function viewOps(ctx: PiViewContext): OpHandlers<keyof ViewOps> {
	return {
		"view.rarebit.ask": (args) => VIEWS.rarebit.ops.ask(ctx, args),
		"view.cos.timeline.locate": (args) => VIEWS["cos.timeline"].ops.locate(ctx, args),
		"view.cos.arc.build": (args) => VIEWS["cos.arc"].ops.build(ctx, args),
	};
}
