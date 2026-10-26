// Pi's coding tools on pi-durable (R3): `read`, `bash`, `edit`, and `write` in Pi's order, with Pi's model-facing text.
// `test/node-request-parity.test.ts` holds the result to Pi's recorded request.
import { createRequire } from "node:module";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";

/** Pi's `bash` text. pi-durable says "combined stdout and stderr" and "Bash command"; the behavior is the same. */
const PI_BASH_DESCRIPTION =
	"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";
const piBashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/** A processor whose `prepare` failed, so its `read` falls back to the one without a processor. */
class ImagesFailed extends Error {}

/**
 * Pi resizes images and converts BMP, so `read` gets pi-durable's Photon processor, which also puts BMP in its text.
 * Photon loads on the first image read, in a worker. Without the Photon package `read` has no processor and says so.
 */
export function photonImages(): ImageProcessor | undefined {
	try {
		createRequire(import.meta.resolve("@earendil-works/pi-durable/images/node")).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm");
	} catch {
		return undefined;
	}
	let processor: Promise<ImageProcessor> | undefined;
	return { prepare: async (bytes, mimeType, limits) => (await (processor ??= createNodePhotonImages())).prepare(bytes, mimeType, limits) };
}

/**
 * The `coding-tools` extension. With `images`, a `read` whose processor throws answers as `read` without one, so a
 * Photon that fails to load costs the conversions, never the read; `report` gets the failure.
 */
export function piCodingTools(options: { images?: ImageProcessor; report?: (error: unknown) => void } = {}): Extension {
	const plain = createReadTool();
	let read = plain;
	const { images } = options;
	if (images) {
		const processed = createReadTool({
			images: {
				async prepare(bytes, mimeType, limits) {
					try {
						return await images.prepare(bytes, mimeType, limits);
					} catch (error) {
						throw new ImagesFailed("image processor failed", { cause: error });
					}
				},
			},
		});
		read = {
			...processed,
			async execute(args, api, context) {
				try {
					return await processed.execute(args, api, context);
				} catch (error) {
					if (!(error instanceof ImagesFailed)) throw error;
					options.report?.(error.cause);
					return plain.execute(args, api, context);
				}
			},
		};
	}
	const bash = { ...createBashTool(), description: PI_BASH_DESCRIPTION, parameters: piBashSchema };
	return defineExtension({ name: "coding-tools", tools: [read, bash, createEditTool(), createWriteTool()] });
}
