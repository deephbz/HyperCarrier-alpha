import "./bound.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/node/daemon.ts";
import { hydrate } from "../src/plugins.ts";
import { TestClient, tempHome } from "./helpers.ts";

const SIM = { provider: "ampi-sim", modelId: "sim-1" };
// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("input: images reach the model and come back on demand; a retried submit is placed once", async () => {
	const home = tempHome();
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: home, model: SIM, prompt: "hello" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.preview);
		await assert.rejects(client.req("thread.submit", { threadId, content: "x", images: [{ data: PNG, mimeType: "image/svg+xml" }] }), /png, jpeg, gif, or webp/);
		await assert.rejects(client.req("thread.submit", { threadId, content: "x", images: [{ data: PNG, mimeType: "image/jpeg" }] }), /not a valid jpeg/, "the label must match the bytes");
		await assert.rejects(client.req("thread.submit", { threadId, content: "x", images: [{ data: "not base64!", mimeType: "image/png" }] }), /not a valid png/);
		// The same intent sent twice (a lost response, then a retry) is one message.
		const submit = { threadId, content: "What does this show?", images: [{ data: PNG, mimeType: "image/png" }], requestId: "intent-1" };
		await client.req("thread.submit", submit);
		await client.req("thread.submit", submit);
		const view = client.sub({ kind: "thread", threadId });
		const done = await client.until<any>(view, (v) => v.entries.some((e: any) => e.kind === "assistant" && /received 1 image/.test(JSON.stringify(e.blocks))));
		const asks = done.entries.filter((e: any) => e.kind === "user" && e.text === "What does this show?");
		assert.equal(asks.length, 1, "placed once");
		assert.equal(asks[0].images, 1);
		assert.ok(!JSON.stringify(done).includes(PNG.slice(0, 40)), "the transcript replica carries no image bytes");
		const fetched = await client.req("thread.images", { threadId, entryId: asks[0].id, index: 0 });
		assert.deepEqual(fetched, { count: 1, image: { data: PNG, mimeType: "image/png" } });
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("input: the owner's pi skills and prompt templates are found, nearest first, within the repository", async () => {
	const home = tempHome();
	const project = join(home, "repo");
	const sub = join(project, "pkg");
	const write = (path: string, text: string) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	};
	write(join(project, ".pi/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Outer deploy\n---\nouter");
	write(join(sub, ".pi/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Inner deploy\n---\ninner");
	write(join(project, ".agents/skills/no-desc/SKILL.md"), "---\nname: no-desc\n---\nskipped: no description");
	write(join(project, ".pi/prompts/review.md"), "---\ndescription: Review a change\n---\nReview $1 for $ARGUMENTS");
	mkdirSync(join(project, ".git"));
	// Above the repository root (a shared directory such as /tmp): never offered.
	write(join(home, ".pi/skills/planted/SKILL.md"), "---\nname: planted\ndescription: From a shared parent directory\n---\nx");
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const found = await client.req("prompts.list", { cwd: sub });
		assert.deepEqual(found.skills.map((k: any) => [k.name, k.description]), [["deploy", "Inner deploy"]], "the nearest skill wins; a skill without a description is not offered");
		assert.deepEqual(found.prompts.map((p: any) => [p.name, p.description, p.body]), [["review", "Review a change", "Review $1 for $ARGUMENTS"]]);
		client.close();
	} finally {
		await daemon.stop();
	}
});

test("input: Changes reads the repository, so edits made through bash show up", async () => {
	const home = tempHome();
	const repo = join(home, "repo");
	mkdirSync(repo);
	const run = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	run(["init", "-q", "-b", "main"]);
	writeFileSync(join(repo, "app.txt"), "one\ntwo\n");
	run(["add", "."]);
	run(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]);
	const daemon = await runDaemon({ home, simTokensPerSecond: 20000, plugins: await hydrate() });
	try {
		const client = await TestClient.connect(daemon.socket);
		const threads = client.sub({ kind: "threads" });
		const { threadId } = await client.req("thread.create", { cwd: repo, model: SIM, prompt: "/sim bash printf 'one\\n2\\n' > app.txt && printf 'new\\n' > notes.txt" });
		await client.until<any>(threads, (v) => v.threads[threadId]?.activity === "idle" && v.threads[threadId]?.preview);
		const changes = await client.req("git.changes", { cwd: repo });
		assert.equal(changes.branch, "main");
		assert.deepEqual(changes.files, [
			{ status: " M", path: "app.txt" },
			{ status: "??", path: "notes.txt" },
		]);
		assert.match(changes.patch, /-two\n\+2/);
		assert.deepEqual(await client.req("git.changes", { cwd: home }), { repo: false });
		client.close();
	} finally {
		await daemon.stop();
	}
});
