// Types for resolve.mjs, for TypeScript hosts.
export type AutoCompactMethod = "native" | "summary" | "keepset";
export type AutoCompactSettings = {
  enabled: boolean;
  threshold: number;
  preservation: "artifact-handoff" | "none";
  method: AutoCompactMethod;
  execution: "foreground" | "background";
  pre_compact_prompt: string;
  budget_tokens?: number;
  modelOverrides?: Record<string, { budget_tokens: number }>;
};
export type ResolvedAutoCompactSettings = {
  settings: AutoCompactSettings;
  /** Invalid values that were ignored. */
  errors: string[];
  /** Pi's merged `compaction` settings. */
  compaction: Record<string, unknown> & { modelOverrides: Record<string, unknown> };
  strategyConfigured: Record<"preservation" | "method" | "execution", unknown>;
};
export const DEFAULT_PRE_COMPACT_PROMPT: string;
export const DEFAULT_AUTO_COMPACT_SETTINGS: Readonly<AutoCompactSettings>;
export const STRATEGY_KEYS: readonly ["preservation", "method", "execution"];
export function isValidThreshold(value: unknown): value is number;
export function settingsObject(value: unknown): Record<string, unknown>;
export function mergeAutoCompactSettings(globalSettings?: Record<string, unknown>, projectSettings?: Record<string, unknown>): Record<string, unknown>;
export function resolveAutoCompactSettings(globalSettings?: Record<string, unknown>, projectSettings?: Record<string, unknown>): ResolvedAutoCompactSettings;
export function resolveSessionStrategy<T extends Partial<ResolvedAutoCompactSettings>>(base?: T, overrides?: Record<string, unknown>): T & { settings: AutoCompactSettings; errors: string[] };
