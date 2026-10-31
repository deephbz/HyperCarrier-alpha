// Image admission: the one decision on which offered files join a message. The Composer (paste, drop, + Image)
// and the hub's refusal both call admitImages, so every offered file is either accepted or rejected with a reason.
import type { ImageLimits } from "./protocol.ts";

/** An offered file as admission sees it: its declared type and its size in base64 characters as sent. */
export type Offered = { name: string; type: string; base64: number };
export type Rejection<F> = { file: F; reason: string };
export type Admission<F> = { accepted: F[]; rejected: Rejection<F>[] };

/** Base64 characters for `bytes` raw bytes, as FileReader's data URL and the wire carry them. */
export const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);

const LABEL: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP" };
const mb = (base64: number) => `${Math.round((base64 * 3) / 4 / 1024 / 102.4) / 10} MB`;

/**
 * Splits `incoming` into the files that join `current` and the files refused, in order, with one reason each.
 * `limits` is the Session's capability; a string says why it takes no images, and every file is refused with it.
 */
export function admitImages<F extends Offered>(current: readonly Pick<Offered, "base64">[], incoming: readonly F[], limits: ImageLimits | string): Admission<F> {
	const accepted: F[] = [];
	const rejected: Rejection<F>[] = [];
	let count = current.length;
	let total = current.reduce((n, image) => n + image.base64, 0);
	for (const file of incoming) {
		const reason = typeof limits === "string" ? limits
			: !file.type.startsWith("image/") ? "not an image"
			: !limits.types.includes(file.type) ? `not ${limits.types.map((type) => LABEL[type] ?? type).join(", ")}`
			: limits.perImageBase64 !== undefined && file.base64 > limits.perImageBase64 ? `larger than ${mb(limits.perImageBase64)} each`
			: count >= limits.count ? `limit ${limits.count} per message`
			: limits.totalBase64 !== undefined && total + file.base64 > limits.totalBase64 ? `over ${mb(limits.totalBase64)} in total per message`
			: undefined;
		if (reason) { rejected.push({ file, reason }); continue; }
		accepted.push(file);
		count++;
		total += file.base64;
	}
	return { accepted, rejected };
}

/** One line for the owner: rejections grouped by reason, e.g. "2 images not added: limit 8 per message". */
export function rejectionLine(rejected: readonly Rejection<Offered>[]): string | undefined {
	if (!rejected.length) return undefined;
	const groups = new Map<string, Offered[]>();
	for (const { file, reason } of rejected) groups.set(reason, [...(groups.get(reason) ?? []), file]);
	return [...groups].map(([reason, files]) => files.length === 1
		? `${files[0]!.name || "1 file"} not added: ${reason}`
		: `${files.length} ${files.every((f) => f.type.startsWith("image/")) ? "images" : "files"} not added: ${reason}`).join(" · ");
}
