import "./bound.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contentArcSeed } from "../scripts/demo/data/content-arc.ts";
import { writeContentSessions } from "../scripts/demo/data/content-transcript.ts";

test("content Arc seed cites existing synthetic Session text", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ampi-content-arc-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const [session] = writeContentSessions(dir, Date.now(), "worst");
	assert.ok(session);
	const entries = new Map(readFileSync(session.file, "utf8").trim().split("\n").map((line) => {
		const entry = JSON.parse(line) as { id?: string };
		return [entry.id, line] as const;
	}));
	const answer = contentArcSeed("worst");
	assert.ok(answer);
	const claims: { cites: { id: string; quote: string }[]; children?: typeof answer.chapters[number]["summary"]["bullets"] }[] = [answer.goal, answer.now, ...answer.chapters.flatMap((chapter) => [chapter.summary.scope]), ...answer.points];
	const collect = (items: typeof answer.chapters[number]["summary"]["bullets"]) => items.forEach((item) => { claims.push(item); if (item.children) collect(item.children); });
	for (const chapter of answer.chapters) collect(chapter.summary.bullets);
	for (const claim of claims) for (const cite of claim.cites) {
		assert.ok(cite.quote.length <= 200, `citation for ${cite.id} stays inside the Arc quote limit`);
		assert.ok(entries.get(cite.id)?.includes(cite.quote), `citation for ${cite.id} appears in its source entry`);
	}
});
