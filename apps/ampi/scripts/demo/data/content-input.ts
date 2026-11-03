/** Composer input cases. These enter through browser typing, paste, or file selection; the hub does not seed them. */
export const CONTENT_LONG_DRAFT = Array.from({ length: 256 }, (_, i) =>
	`Update ${i + 1}: the reader check passed on the narrow viewport. Keep the source citation, then rerun the keyboard and touch checks before release.`,
).join("\n\n");

/** The composer admits up to eight images and counts their base64 payload against this total. */
export const CONTENT_IMAGE_COUNT = 8;
export const CONTENT_IMAGE_TOTAL_BASE64 = 6 * 1024 * 1024;
/** Eight equal payloads sum to the accepted total exactly. */
export const CONTENT_IMAGE_BASE64_EACH = CONTENT_IMAGE_TOTAL_BASE64 / CONTENT_IMAGE_COUNT;
/** One additional byte beyond the total limit, for a rejected-file case. */
export const CONTENT_OVERSIZE_IMAGE_BASE64 = CONTENT_IMAGE_TOTAL_BASE64 + 4;
