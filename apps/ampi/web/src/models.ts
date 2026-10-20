import { useEffect, useState } from "react";
import { hub } from "./client.ts";
import type { ModelChoice } from "./components/ThreadView.tsx";

const SIM = "ampi-sim";
const cache = new Map<string, ModelChoice[]>();

/** One host's available models, refreshed when an account changes there. `undefined` until known. */
export function useModels(host: string | undefined, connected: boolean): ModelChoice[] | undefined {
	const [models, setModels] = useState<ModelChoice[] | undefined>(host ? cache.get(host) : undefined);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const changed = (e: Event) => {
			if ((e as CustomEvent).detail === host) {
				cache.delete(host!);
				setTick((t) => t + 1);
			}
		};
		window.addEventListener("ampi:models-changed", changed);
		return () => window.removeEventListener("ampi:models-changed", changed);
	}, [host]);
	useEffect(() => {
		if (!host) return setModels(undefined);
		setModels(cache.get(host));
		if (!connected) return;
		let live = true;
		hub.request(host, "models.list").then(
			(list) => {
				cache.set(host, list);
				if (live) setModels(list);
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [host, connected, tick]);
	return models;
}

/** Whether a host has any real (non-simulated) model signed in. */
export function hasRealModel(models: ModelChoice[] | undefined): boolean | undefined {
	return models === undefined ? undefined : models.some((m) => m.provider !== SIM);
}
