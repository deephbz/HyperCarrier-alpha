import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boundToolArgs, clipInjected, injectedMessage, TOOL_ARGS_MIN, toolArgsPreview } from "../src/shared/entry-shapes.ts";
import { TOOL_ARGS_CHARS } from "../src/pi/working-set-types.ts";

const bounded = (name: string, raw: unknown, limit: number) => boundToolArgs(toolArgsPreview(name, raw), limit);

const delivery = (messages: { from: string; content: string }[]) =>
	`These accepted coordination records were delivered to this exact Session.\n${JSON.stringify({ messages: messages.map((m, i) => ({ id: `msg_${i}`, ...m })) }, null, 2)}`;

test("injected message: each extension message names its kind, sender and text", () => {
	const intercom = injectedMessage("intercom_message", "**From planner** (/work/p)\n\n_Delivered by intercom at 12:00_\n\nPlease review.\nMore.");
	assert.deepEqual(intercom, { kind: "intercom", label: "intercom", sender: "planner", text: "Please review.\nMore." });
	const direct = injectedMessage("pi-team-bright.direct-message", delivery([{ from: "lead", content: "Plan accepted.\nDetail." }, { from: "observer", content: "Noted." }]));
	assert.deepEqual([direct.kind, direct.label, direct.sender, direct.text, direct.parts?.length], ["direct-message", "direct message", "lead, observer", "Plan accepted.\nDetail.", 2]);
	const alert = injectedMessage("pi-team-bright.direct-message", delivery([{ from: "lead", content: "[PiTeams clarification Alert alert_1]\nTask: t" }]));
	assert.deepEqual([alert.kind, alert.label, alert.parts], ["alert", "alert", undefined]);
	const update = injectedMessage("pi-team-bright.task-update", delivery([{ from: "lead", content: "Task t: ready" }]));
	assert.deepEqual([update.kind, update.label, update.sender], ["team-update", "task update", "lead"]);
	const pickup = injectedMessage("auto-compact.pickup", "Auto Compact pickup: continue.\n\nBody");
	assert.deepEqual(pickup, { kind: "auto-compact", label: "pickup", sender: "Auto Compact", text: "Auto Compact pickup: continue.\n\nBody" });
	assert.deepEqual(injectedMessage("team.notice", "\n  First line\nrest"), { kind: "other", label: "team.notice", text: "\n  First line\nrest" });
	assert.equal(injectedMessage("ext.alert", "x").kind, "alert", "an unknown kind that names an alert keeps its attention badge");
});

test("injected message: a shortened delivery still yields its sender and first message", () => {
	const text = delivery([{ from: "lead \"a\"", content: `Long \u00e9 start.\n${"x".repeat(2000)}` }]).slice(0, 400);
	const message = injectedMessage("pi-team-bright.direct-message", text);
	assert.equal(message.sender, 'lead "a"');
	assert.match(message.text, /^Long \u00e9 start\.\nx+$/);
});

test("injected message: clipping shares one budget across the text and the parts", () => {
	const message = injectedMessage("pi-team-bright.direct-message", delivery([{ from: "a", content: "1234567890" }, { from: "b", content: "abcdefghij" }]));
	assert.deepEqual(clipInjected(message, 100), { message, clipped: false });
	const cut = clipInjected(message, 15);
	assert.equal(cut.clipped, true);
	assert.deepEqual(cut.message.parts, [{ from: "a", text: "1234567890" }, { from: "b", text: "abcde" }]);
	assert.equal(cut.message.text, "1234567890");
	assert.deepEqual(clipInjected(message, 4).message.parts, [{ from: "a", text: "1234" }], "an emptied part drops");
});

test("tool args preview: the change, the targets and the rest share one bound", () => {
	const edit = toolArgsPreview("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] });
	assert.deepEqual(edit, { summary: "src/a.ts · 1 edit(s)", path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] });
	assert.deepEqual(boundToolArgs(edit, TOOL_ARGS_CHARS), { args: edit, clipped: false }, "a preview within the bound returns unchanged");
	const write = toolArgsPreview("write", { file_path: "notes.md", content: "one\ntwo\n" });
	assert.deepEqual([write.path, write.content, write.text], ["notes.md", "one\ntwo\n", undefined], "file_path names the target");
	const task = toolArgsPreview("task_update", { task_id: "t1", transition: "goal_achieved", evidence: "ok" });
	assert.equal(task.summary, "t1 → goal_achieved");
	assert.deepEqual(JSON.parse(task.text!), { task_id: "t1", transition: "goal_achieved", evidence: "ok" });
	assert.deepEqual(toolArgsPreview("bash", { command: "ls" }), { summary: "ls", command: "ls" });
	assert.deepEqual(toolArgsPreview("odd", "not an object"), { summary: "{}" });

	const big = { path: "src/big.ts", edits: [{ oldText: "x".repeat(TOOL_ARGS_CHARS), newText: "y" }] };
	assert.deepEqual(bounded("edit", big, TOOL_ARGS_CHARS), { args: { summary: "src/big.ts · 1 edit(s)", path: "src/big.ts", omitted: { edits: 1 } }, clipped: true });
	const full = toolArgsPreview("edit", big);
	assert.ok(JSON.stringify(full).length > TOOL_ARGS_CHARS);
	assert.deepEqual(boundToolArgs(full, TOOL_ARGS_CHARS), { args: { summary: "src/big.ts · 1 edit(s)", path: "src/big.ts", omitted: { edits: 1 } }, clipped: true }, "bounding a full preview equals bounding the raw arguments");
	const content = bounded("write", { path: "w.txt", content: "z".repeat(TOOL_ARGS_CHARS) }, TOOL_ARGS_CHARS);
	assert.deepEqual([content.clipped, content.args.content], [true, undefined], "content counts inside the same budget");
	const command = bounded("bash", { command: "c".repeat(5000) }, TOOL_ARGS_CHARS);
	assert.deepEqual([command.clipped, command.args.omitted], [true, { command: true }], "a long command is cut to the remaining budget");
	assert.ok(command.args.command!.length > 1500 && JSON.stringify(command.args).length <= TOOL_ARGS_CHARS);
});

test("tool args preview: a clipped preview stays within its bound however many targets the call names", () => {
	const paths = (n: number) => Array.from({ length: n }, (_, i) => `src/${String(i).padStart(3, "0")}/${"p".repeat(210)}`);
	const size = (n: number) => {
		const { args, clipped } = bounded("read", { paths: paths(n) }, TOOL_ARGS_CHARS);
		assert.equal(clipped, true);
		return JSON.stringify(args).length;
	};
	assert.ok(size(100) <= TOOL_ARGS_CHARS, `100 paths serialize to ${size(100)} chars`);
	assert.ok(size(1000) <= TOOL_ARGS_CHARS, "the clipped size does not grow with the number of targets");
	const { args } = bounded("read", { paths: paths(100) }, TOOL_ARGS_CHARS);
	assert.equal(args.paths!.length + args.omitted!.paths!, 100, "the preview counts the paths it dropped");
	assert.deepEqual(args.paths, paths(100).slice(0, args.paths!.length), "kept paths are whole items from the front");
	const near = bounded("bash", { command: "c".repeat(5000), note: "n".repeat(500) }, TOOL_ARGS_CHARS);
	assert.ok(JSON.stringify(near.args).length <= TOOL_ARGS_CHARS, `command and summary serialize to ${JSON.stringify(near.args).length} chars`);
});

test("tool args preview: any call serializes within the limit, and an unclipped preview is the whole preview", () => {
	const ctrl = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("");
	const calls: [string, Record<string, unknown>][] = [
		["read", { paths: Array.from({ length: 100 }, (_, i) => `${i}/${"p".repeat(218)}`) }],
		["bash", { command: "c".repeat(5000) }],
		["bash", { command: "c".repeat(10_000) }],
		["bash", { command: `echo ${'"'.repeat(1500)}` }],
		["bash", { command: `${"😀".repeat(900)}${ctrl.repeat(40)}` }],
		["write", { path: "😀.md", content: `${ctrl}${"😀".repeat(3000)}` }],
		["edit", { path: "src/a.ts", edits: [{ oldText: "o".repeat(2048), newText: "n" }] }],
		["edit", { path: "src/a.ts", edits: Array.from({ length: 400 }, (_, i) => ({ oldText: `old ${i} "x"`, newText: `new ${i}\n` })) }],
		["write", { path: "w.txt", content: "z".repeat(2048) }],
		["task_update", { task_id: "t1", transition: "goal_achieved", evidence: "e\"".repeat(1500) }],
		["odd", Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, `value ${i} ${"v".repeat(40)}`]))],
		["read", { path: "p".repeat(400), paths: ["a".repeat(400)], command: "\\".repeat(3000) }],
	];
	for (let n = 1500; n <= 2100; n += 7) calls.push(["write", { path: "w.txt", content: "z".repeat(n) }]);
	for (const limit of [TOOL_ARGS_CHARS, 600, 200]) for (const [name, raw] of calls) {
		const { args, clipped } = bounded(name, raw, limit);
		const label = `${name} ${JSON.stringify(raw).slice(0, 40)} at ${limit}`;
		assert.ok(JSON.stringify(args).length <= limit, `${label}: ${JSON.stringify(args).length} serialized chars`);
		const whole = toolArgsPreview(name, raw);
		if (!clipped) assert.deepEqual(args, whole, `${label}: unclipped preview is the whole preview`);
		assert.equal(clipped, args.omitted !== undefined && Object.keys(args.omitted).length > 0, `${label}: clipped iff something is recorded as omitted`);
		assert.deepEqual(boundToolArgs(args, limit).args, args, `${label}: bounding is idempotent`);
	}
	assert.equal(JSON.stringify(bounded("bash", { command: "😀".repeat(2000) }, 600).args).includes("\\ud83d"), false, "a cut never splits a surrogate pair");
	assert.throws(() => bounded("bash", { command: "ls" }, TOOL_ARGS_MIN - 1), RangeError, "a limit below the minimum cannot hold the bound");
});
