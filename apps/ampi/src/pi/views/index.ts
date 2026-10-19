// Views a Pi Host serves. One line per view; each lives in its own file and owns its own tests.

import { rarebitView } from "./rarebit.ts";
import { teamView } from "./team.ts";
import type { PiView } from "./types.ts";
import { cosTimeline } from "./cos-timeline.ts";
import { cosArc } from "./cos-arc.ts";

export const PI_VIEWS: PiView[] = [rarebitView, teamView, cosTimeline, cosArc];
