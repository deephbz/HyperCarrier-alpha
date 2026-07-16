import { DEFAULT_RAREBIT_SUMMARY_POLICY } from "./rarebit-core.mjs";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Merge just the dedicated Rarebit namespace.  Pi's broader settings merge is
 * deliberately not reimplemented here: this boundary has only one nested
 * object whose inheritable fields must survive a Project override.
 */
export function mergeRarebitSettings(
  globalSettings = {},
  projectSettings = {},
) {
  const globalRarebit =
    globalSettings?.rarebit && typeof globalSettings.rarebit === "object"
      ? globalSettings.rarebit
      : {};
  const projectRarebit =
    projectSettings?.rarebit && typeof projectSettings.rarebit === "object"
      ? projectSettings.rarebit
      : {};
  return { ...globalRarebit, ...projectRarebit };
}

export function modelFromRarebitSettings(rarebit) {
  const candidate = rarebit?.model;
  if (candidate && typeof candidate === "object") {
    const provider = nonEmptyString(candidate.provider);
    const id = nonEmptyString(candidate.id);
    if (provider && id) return { model: { provider, id } };
  }
  const spec = nonEmptyString(candidate);
  if (spec) {
    const separator = spec.indexOf("/");
    if (separator > 0 && separator < spec.length - 1)
      return {
        model: {
          provider: spec.slice(0, separator),
          id: spec.slice(separator + 1),
        },
      };
  }
  if (candidate === undefined)
    return { error: "Rarebit setting rarebit.model is missing" };
  return {
    error:
      "Rarebit setting rarebit.model must be provider/model or {provider,id}",
  };
}

/**
 * Pure configuration interpretation used identically by the interactive Pi
 * extension and the external CLI.  A caller supplies already-read global and
 * trusted-Project JSON objects; this function never reads files or falls back
 * to Pi's interactive default model.
 */
export function resolveRarebitSettings(
  globalSettings = {},
  projectSettings = {},
) {
  const rarebit = mergeRarebitSettings(globalSettings, projectSettings);
  const resolved = modelFromRarebitSettings(rarebit);
  return {
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.error ? { modelConfigurationError: resolved.error } : {}),
    summaryPolicy: {
      ...DEFAULT_RAREBIT_SUMMARY_POLICY,
      ...(rarebit.min_total_length === undefined
        ? {}
        : { minTotalLength: Number(rarebit.min_total_length) }),
      ...(rarebit.max_rarebit_ratio === undefined
        ? {}
        : { maxRarebitRatio: Number(rarebit.max_rarebit_ratio) }),
    },
    autoTitle: rarebit.auto_title !== false,
  };
}
