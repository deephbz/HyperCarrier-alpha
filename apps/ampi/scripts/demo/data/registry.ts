import { readdirSync, unlinkSync } from "node:fs";
import { contentArcSeed, writeContentSessions } from "./content.ts";
import { join } from "node:path";
import type { DemoSession } from "../sessions.ts";
import type { DemoDataMode } from "./modes.ts";
export { contentArcSeed, writeContentSessions };

export type DemoFixtureSet = {
	sessions: DemoSession[];
	content?: Record<string, unknown>;
};

/** Merge the base Session fixtures with named contributors, then apply the selected list shape. */
export function demoFixtures(mode: DemoDataMode, sessions: DemoSession[], additions: DemoFixtureSet[] = []): DemoFixtureSet {
	const merged: DemoFixtureSet = {
		sessions: [...sessions, ...additions.flatMap((addition) => addition.sessions)],
		content: Object.assign({}, ...additions.map((addition) => addition.content)),
	};
	if (mode === "empty") return { sessions: [], content: merged.content };
	if (mode === "one") {
		const contentSessions = additions.flatMap((addition) => addition.sessions);
		return { sessions: contentSessions.slice(0, 1).length ? contentSessions.slice(0, 1) : merged.sessions.slice(0, 1), content: merged.content };
	}
	return merged;
}

/** Keep only selected Session sources in the disposable demo data directory. */
export function pruneDemoSessions(agentDir: string, keep: Set<string>): void {
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (path.endsWith(".jsonl") && !keep.has(path)) unlinkSync(path);
		}
	};
	visit(join(agentDir, "sessions"));
}
