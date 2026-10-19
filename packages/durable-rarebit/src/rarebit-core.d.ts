// The pinned `@hypercarrier/rarebit` (v0.5.2) ships one types.d.ts for every subpath, and it lags `rarebit-core.mjs`:
// these runtime exports and the title options are missing from it. Declare them here until the upstream types catch
// up; each declaration mirrors the pinned runtime exactly.
import type { RarebitSummaryPolicy } from "@hypercarrier/rarebit/core";

declare module "@hypercarrier/rarebit/core" {
	export const RAREBIT_SUMMARY_PROMPT_VERSION: string;
	export const DEFAULT_RAREBIT_SUMMARY_POLICY: Readonly<Required<RarebitSummaryPolicy>>;
	export function normalizeRarebitTitle(value: unknown, options?: { maxChars?: number }): string;
}
