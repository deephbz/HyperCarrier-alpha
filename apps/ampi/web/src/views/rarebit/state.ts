import { useSyncExternalStore } from "react";
import type { RarebitSide } from "../../../../src/pi/views/rarebit.ts";

type State = { lens: boolean; hide: boolean; diagnosis: boolean; window: number; side?: RarebitSide; pending?: string; draft: string; model: string; error?: string };
const stores = new Map<string, { value: State; listeners: Set<() => void> }>();

// Session-local UI state survives panel redraws and Session switches, never enters localStorage or the transcript.
export function rarebitState(host: string, threadId: string) {
	const key = `${host}|${threadId}`;
	let store = stores.get(key);
	if (!store) {
		const lens = localStorage.getItem("ampi.transcript.mode") === "conversation";
		store = { value: { lens, hide: false, diagnosis: false, window: 60, draft: "", model: "" }, listeners: new Set() };
		stores.set(key, store);
	}
	const current = store;
	return {
		get: () => current.value,
		subscribe: (listener: () => void) => { current.listeners.add(listener); return () => { current.listeners.delete(listener); }; },
		set: (patch: Partial<State>) => {
			current.value = { ...current.value, ...patch };
			if (patch.lens !== undefined) localStorage.setItem("ampi.transcript.mode", patch.lens ? "conversation" : "full");
			for (const listener of current.listeners) listener();
		},
	};
}

export function useRarebitState(host: string, threadId: string) {
	const store = rarebitState(host, threadId);
	return [useSyncExternalStore(store.subscribe, store.get), store.set] as const;
}
