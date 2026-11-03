import type { ArcAnswer } from "../../../src/shared/arc.ts";
import type { DemoSession } from "../sessions.ts";
import { contentArcSeed as arcSeed } from "./content-arc.ts";
import { writeContentSessions as writeSessions } from "./content-transcript.ts";
export { CONTENT_IMAGE_BASE64_EACH, CONTENT_IMAGE_COUNT, CONTENT_IMAGE_TOTAL_BASE64, CONTENT_LONG_DRAFT, CONTENT_OVERSIZE_IMAGE_BASE64 } from "./content-input.ts";
export { CONTENT_FIND_QUERY, CONTENT_TEXT } from "./content-transcript.ts";

type DemoDataMode = "demo" | "worst" | "empty" | "one" | "huge";

/** Add the content-focused Sessions to the fixture registry's existing demo data. */
export function writeContentSessions(agentDir: string, now: number, mode: DemoDataMode): DemoSession[] {
	return writeSessions(agentDir, now, mode);
}

/** A typed Arc answer for the demo hub's synthetic content Session, or no replacement answer. */
export function contentArcSeed(mode: DemoDataMode): ArcAnswer | undefined {
	return arcSeed(mode);
}
