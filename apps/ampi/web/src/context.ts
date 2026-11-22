import { createContext, useContext } from "react";
import type { HostThreads } from "./components/Sidebar.tsx";
import type { KeyIntent } from "./focus.ts";

export const FeedsContext = createContext<Record<string, HostThreads>>({});
export const useFeeds = () => useContext(FeedsContext);

/** Runs a focus intent through the focus model (focus.ts); false when the intent is unavailable here. */
export const FocusIntentContext = createContext<(intent: KeyIntent) => boolean>(() => false);
export const useFocusIntent = () => useContext(FocusIntentContext);

/** A deferred placement uses the generation captured when its request began. */
export type FocusPlacement = {
	capture: () => number;
	place: (target: HTMLElement, generation: number, options?: FocusOptions) => boolean;
};
/** The App rejects deferred focus after a newer owner action. */
export const FocusPlacementContext = createContext<FocusPlacement>({
	capture: () => 0,
	place: (target, _generation, options) => { target.focus(options); return true; },
});
export const useFocusPlacement = () => useContext(FocusPlacementContext);
