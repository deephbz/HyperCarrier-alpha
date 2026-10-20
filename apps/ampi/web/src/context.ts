import { createContext, useContext } from "react";
import type { HostThreads } from "./components/Sidebar.tsx";
import type { KeyIntent } from "./focus.ts";

export const FeedsContext = createContext<Record<string, HostThreads>>({});
export const useFeeds = () => useContext(FeedsContext);

/** Runs a focus intent through the focus model (focus.ts); false when the intent is unavailable here. */
export const FocusIntentContext = createContext<(intent: KeyIntent) => boolean>(() => false);
export const useFocusIntent = () => useContext(FocusIntentContext);
