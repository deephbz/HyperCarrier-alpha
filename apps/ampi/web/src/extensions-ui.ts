// The web UI registration file: the one web file another line edits to register components (scripts/lines-footprint.allow).
// It fills the slot registries in slot-registry.ts. Only the app entry (main.tsx) loads it, before the first render, so a
// registered kind module may import any main component. Main registers nothing. Node tests read the pure extensions.ts.

import { AccountsLayer, durableUi, Onboarding, SettingsNotices, ShowArchived, ShowChecklist } from "./durable/shell.tsx";
import { durableThread, MESSAGES_MODE } from "./durable/thread-surface.tsx";
import { appLayers, helpActions, kindUis, overviewSteps, sidebarFooter, teamModes } from "./slot-registry.ts";

Object.assign(kindUis, { durable: { ...durableUi, thread: durableThread } });
appLayers.push(SettingsNotices, AccountsLayer);
overviewSteps.push(Onboarding);
sidebarFooter.push(ShowArchived);
helpActions.push(ShowChecklist);
teamModes.push(MESSAGES_MODE);
