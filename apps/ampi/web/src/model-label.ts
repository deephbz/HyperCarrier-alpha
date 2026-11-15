/** A compact model ID and its known effort. The HUD keeps the full identity. */
export function modelLabel(model: string, thinking?: string, thinkingLevels: readonly string[] = []): string {
	const id = model.split("/").at(-1)!.replace(/^claude-/, "")
		.replace(/-(?:latest|\d{8}|\d{4}-\d{2}-\d{2})$/, "")
		.replace(/^(\d+)-(\d+)-(opus|sonnet|haiku)$/, "$3-$1.$2")
		.replace(/-(\d+)-(\d+)$/, "-$1.$2");
	const short = id.length > 18 ? id.slice(0, 18) + "…" : id;
	return short + (thinking && thinkingLevels.some(level => level !== "off") ? " · " + thinking : "");
}
