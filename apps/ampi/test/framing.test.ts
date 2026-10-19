import assert from "node:assert/strict";
import { test } from "node:test";
import { lineReader } from "../src/shared/framing.ts";

test("framing: a multibyte character split across reads survives", () => {
	const text = "─界😀";
	const bytes = Buffer.from(`${JSON.stringify({ text })}\n`);
	for (let cut = 1; cut < bytes.length; cut++) {
		const lines: string[] = [];
		const read = lineReader((line) => lines.push(line));
		read(bytes.subarray(0, cut));
		read(bytes.subarray(cut));
		assert.equal(JSON.parse(lines[0]!).text, text, `cut at byte ${cut}`);
	}
});
