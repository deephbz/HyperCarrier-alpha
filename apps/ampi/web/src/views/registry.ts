// The GUI's view seam (docs/one-gui-views.md). A workstream adds one entry here and keeps everything else in its own
// files under views/<name>/: components, styles (tokens only), and tests. Shared files stay untouched.

import type { ComponentType } from "react";
import type { ThreadSummary } from "../../../src/shared/protocol.ts";
import type { Route } from "../util.ts";
import { TeamPanel } from "./team/TeamPanel.tsx";
import { RarebitView } from "./rarebit/View.tsx";
import { RarebitBand } from "./rarebit/Lens.tsx";
import { Timeline, TimelinePanel } from "./cos/Timeline.tsx";
import { Arcs } from "./cos/Arcs.tsx";
import { ArcPanel } from "./cos/ArcPanel.tsx";

/** A side panel beside a Pi Session's transcript (Rarebit, Team, Arc). */
export type PanelView = {
	name: string;
	label: string;
	/** Shown in the panel's tabs only when this returns true for the open Session. */
	available?: (summary: ThreadSummary | undefined) => boolean;
	component: ComponentType<{ host: string; threadId: string; summary?: ThreadSummary; entry?: string }>;
};

/** A top-level page with its own address, `#/v/<name>/…` (Chief of Staff pages). */
export type PageView = {
	name: string;
	label: string;
	/** Groups pages in the sidebar's navigation, e.g. "Chief of Staff". */
	section: string;
	component: ComponentType<{ route: Route }>;
};

export const PI_PANELS: PanelView[] = [
	{ name: "rarebit", label: "Rarebit", component: RarebitView },
	{ name: "team", label: "Team", available: (summary) => Boolean(summary?.team), component: TeamPanel },
	{ name: "timeline", label: "Timeline", component: TimelinePanel },
	{ name: "arc", label: "Arc", component: ArcPanel },
];
export const PI_BANDS = [RarebitBand];
export const PAGES: PageView[] = [{ name: "timeline", label: "Timeline", section: "Chief of Staff", component: Timeline }, { name: "arcs", label: "Arcs", section: "Chief of Staff", component: Arcs }];
