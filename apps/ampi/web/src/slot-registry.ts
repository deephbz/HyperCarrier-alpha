// The App shell's slot registries. Components read them here; a line fills them in extensions-ui.ts, which only the app
// entry loads, before the first render. This module loads nothing at runtime, so a component that reads a slot closes
// no import cycle (test/web-import-cycles.test.ts). Each list draws after main's own content, in registration order.

import type { ComponentType } from "react";
import type { AppLayerProps, HelpActionProps, HostKindUi, OverviewStepProps, SidebarFooterProps, TeamMode } from "./shell-slots.ts";

/** A Host kind's UI by its source (HostKind.source). */
export const kindUis: Record<string, HostKindUi> = {};

/** Toasts and dialogs the App draws over every view. */
export const appLayers: ComponentType<AppLayerProps>[] = [];

/** Steps the Overview shows above its activity summary. */
export const overviewSteps: ComponentType<OverviewStepProps>[] = [];

/** Buttons in the sidebar footer, before Help. */
export const sidebarFooter: ComponentType<SidebarFooterProps>[] = [];

/** Buttons in the Help dialog, before Close. */
export const helpActions: ComponentType<HelpActionProps>[] = [];

/** Team panel views after Tasks; with one registered, the panel shows a Tasks toggle. */
export const teamModes: TeamMode[] = [];
