import { IMAGE_LIMITS } from "@hypercarrier/pi-hc-control/control";

/** Composer input cases. These enter through browser typing, paste, or file selection; the hub does not seed them. */
export const CONTENT_LONG_DRAFT = Array.from({ length: 256 }, (_, i) =>
	`Update ${i + 1}: the reader check passed on the narrow viewport. Keep the source citation, then rerun the keyboard and touch checks before release.`,
).join("\n\n");

/** The fixture uses the carrier's image count, MIME types and aggregate base64 limit. */
export const CONTENT_IMAGE_COUNT = IMAGE_LIMITS.count;
if (IMAGE_LIMITS.totalBase64 === undefined) throw new Error("content input fixture requires the carrier's total image limit");
export const CONTENT_IMAGE_TOTAL_BASE64 = IMAGE_LIMITS.totalBase64;
/** Equal payloads sum to the carrier's accepted total exactly. */
export const CONTENT_IMAGE_BASE64_EACH = CONTENT_IMAGE_TOTAL_BASE64 / CONTENT_IMAGE_COUNT;
/** One additional byte beyond the total limit, for a rejected-file case. */
export const CONTENT_OVERSIZE_IMAGE_BASE64 = CONTENT_IMAGE_TOTAL_BASE64 + 4;
