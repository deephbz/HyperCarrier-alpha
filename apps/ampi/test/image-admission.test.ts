import "./bound.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore: pi-hc-control is plain ESM.
import { IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";
import { admitImages, base64Length, rejectionLine, type Offered } from "../src/shared/image-admission.ts";
import { NODE_IMAGE_LIMITS } from "../src/node/images.ts";
import type { ImageLimits } from "../src/shared/protocol.ts";

const png = (name: string, base64 = 100): Offered => ({ name, type: "image/png", base64 });
const pi: ImageLimits = IMAGE_LIMITS;

// The invariant: every offered file is accepted or rejected with a reason, in order, never dropped.
function assertPartition(offered: Offered[], result: ReturnType<typeof admitImages<Offered>>) {
	assert.deepEqual([...result.accepted, ...result.rejected.map((r) => r.file)].sort((a, b) => offered.indexOf(a) - offered.indexOf(b)), offered);
	for (const { reason } of result.rejected) assert.ok(reason.length > 0);
}

test("each member of the class is rejected with its own reason; the rest are accepted", () => {
	const MB = base64Length(1024 * 1024);
	const limits: ImageLimits = { count: 3, types: ["image/png", "image/jpeg"], perImageBase64: MB, totalBase64: 2 * MB };
	const offered = [
		png("a.png"),
		{ name: "notes.txt", type: "text/plain", base64: 10 },
		{ name: "b.tiff", type: "image/tiff", base64: 10 },
		png("huge.png", MB + 4),
		png("c.png", MB),
		png("d.png", MB),
		png("e.png"),
		png("f.png"),
	];
	const result = admitImages([], offered, limits);
	assertPartition(offered, result);
	assert.deepEqual(result.accepted.map((f) => f.name), ["a.png", "c.png", "e.png"]);
	assert.deepEqual(result.rejected.map((r) => [r.file.name, r.reason]), [
		["notes.txt", "not an image"],
		["b.tiff", "not PNG, JPEG"],
		["huge.png", "larger than 1 MB each"],
		["d.png", "over 2 MB in total per message"],
		["f.png", "limit 3 per message"],
	]);
});

test("nine images on Pi: eight join, the ninth is named with the limit (adv R1)", () => {
	const offered = Array.from({ length: 9 }, (_, i) => png(`image-${i + 1}.png`));
	const result = admitImages([], offered, pi);
	assertPartition(offered, result);
	assert.equal(result.accepted.length, 8);
	assert.equal(rejectionLine(result.rejected), "image-9.png not added: limit 8 per message");
});

test("images already attached count toward the limits", () => {
	const result = admitImages(Array.from({ length: 7 }, () => ({ base64: 10 })), [png("a.png"), png("b.png"), png("c.png")], pi);
	assert.deepEqual(result.accepted.map((f) => f.name), ["a.png"]);
	assert.equal(rejectionLine(result.rejected), "2 images not added: limit 8 per message");
	const full = admitImages([{ base64: pi.totalBase64! - 50 }], [png("a.png")], pi);
	assert.equal(rejectionLine(full.rejected), "a.png not added: over 4.5 MB in total per message");
});

test("a Session that takes no images refuses every file with the reason it gives", () => {
	const offered = [png("a.png"), { name: "b.txt", type: "text/plain", base64: 4 }];
	const result = admitImages([], offered, "this Session has no live control");
	assertPartition(offered, result);
	assert.equal(rejectionLine(result.rejected), "2 files not added: this Session has no live control");
});

test("the carriers' limits are well formed and stated in the units the wire carries", () => {
	for (const limits of [pi, NODE_IMAGE_LIMITS]) {
		assert.ok(limits.count > 0 && limits.types.length > 0);
		assert.ok(limits.perImageBase64 !== undefined || limits.totalBase64 !== undefined, "a carrier bounds bytes");
	}
	assert.equal(base64Length(5 * 1024 * 1024), NODE_IMAGE_LIMITS.perImageBase64);
	assert.equal(base64Length(3), 4);
	assert.equal(base64Length(4), 8);
});
