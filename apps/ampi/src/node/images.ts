// The AmPi node's image limits: its submit check and its Session capability both read them (protocol ImageLimits).
import type { ImageLimits } from "../shared/protocol.ts";
import { base64Length } from "../shared/image-admission.ts";

/** Magic bytes per accepted type: the label must match the bytes, or providers reject the image on every turn. */
export const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
	"image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
	"image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	"image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
	"image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

export const NODE_IMAGE_LIMITS: ImageLimits = { count: 8, types: Object.keys(IMAGE_MAGIC), perImageBase64: base64Length(5 * 1024 * 1024) };
