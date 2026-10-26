import "./bound.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { photonImages, piCodingTools } from "../src/node/coding-tools.ts";
import { tempHome } from "./helpers.ts";

/** A 2x2 24-bit BMP: a format the model cannot take inline, so `read` must convert it. */
function bmp(): Buffer {
	const row = Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]); // two BGR pixels and two bytes of row padding
	const header = Buffer.alloc(54);
	header.write("BM", 0, "latin1");
	header.writeUInt32LE(54 + 2 * row.length, 2);
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(2, 18);
	header.writeInt32LE(2, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	header.writeUInt32LE(2 * row.length, 34);
	return Buffer.concat([header, row, row]);
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function readTool(options: Parameters<typeof piCodingTools>[0]) {
	const dir = tempHome();
	writeFileSync(join(dir, "pixel.bmp"), bmp());
	writeFileSync(join(dir, "pixel.png"), PNG);
	const read = piCodingTools(options).tools!.find((tool) => tool.name === "read")!;
	// No conversation model: `read` treats it as one that takes images within the default limits.
	const api = { env: new NodeExecutionEnv({ cwd: dir }), agent: async () => ({}), models: { getModel: () => undefined } } as any;
	return { read, call: (path: string) => read.execute({ path }, api, BACKGROUND_CONTEXT) as Promise<any> };
}

test("coding tools: read converts a real BMP to PNG with Photon, as Pi does", async () => {
	const images = photonImages();
	assert.ok(images, "the Photon package resolves");
	const { read, call } = readTool({ images });
	assert.match(read.description, /\(jpg, png, gif, webp, bmp\)/);
	const result = await call("pixel.bmp");
	assert.equal(result.isError, undefined, JSON.stringify(result.diagnostics));
	assert.equal(result.output[0].type, "image");
	assert.equal(result.output[0].mimeType, "image/png");
	assert.match(result.diagnostics[0].message, /Converted from image\/bmp to image\/png/);
});

test("coding tools: a failing image processor degrades read to no processor, never a crash", async () => {
	const reported: unknown[] = [];
	const failing = { prepare: async () => { throw new Error("photon wasm missing"); } };
	const { call } = readTool({ images: failing, report: (error) => reported.push(error) });
	const png = await call("pixel.png");
	assert.equal(png.output[0].type, "image", "an inline image within the limits passes through as it is");
	assert.equal(png.output[0].data, PNG.toString("base64"));
	const converted = await call("pixel.bmp");
	assert.equal(converted.isError, true);
	assert.match(JSON.stringify(converted), /needs converting, and no image processor is configured/);
	assert.deepEqual(reported.map((error) => (error as Error).message), ["photon wasm missing", "photon wasm missing"]);
});

test("coding tools: without a processor read lists only the formats it sends as they are", () => {
	const { read } = readTool({});
	assert.match(read.description, /\(jpg, png, gif, webp\)\./);
});
