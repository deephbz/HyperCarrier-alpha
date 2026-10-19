import { createContext, useContext } from "react";
import type { HostThreads } from "./components/Sidebar.tsx";

export const FeedsContext = createContext<Record<string, HostThreads>>({});
export const useFeeds = () => useContext(FeedsContext);
