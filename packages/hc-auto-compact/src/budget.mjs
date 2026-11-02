// Owns budget precedence and summary caps arithmetic only. Sampling, settings
// snapshots and the Session override stay in the controller. The model window
// is a separate input because the wrapper samples it lazily, with a context-usage
// fallback when the model does not supply a window.

export function utilizationAtOrAboveThreshold(usage, threshold) {
  if (!usage || typeof usage.contextWindow !== "number")
    return { known: false, crossed: false };
  if (typeof usage.percent === "number" && Number.isFinite(usage.percent))
    return {
      known: true,
      crossed: usage.percent >= threshold,
      percent: usage.percent,
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
    };
  if (
    typeof usage.tokens === "number" &&
    Number.isFinite(usage.tokens) &&
    usage.contextWindow > 0
  ) {
    const percent = (usage.tokens / usage.contextWindow) * 100;
    return {
      known: true,
      crossed: percent >= threshold,
      percent,
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
    };
  }
  return {
    known: false,
    crossed: false,
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
  };
}

export function resolveBudget(settings, sessionBudgetOverride, model, modelWindow) {
  const modelBudget =
    settings.modelOverrides?.[
      `${model?.provider}/${model?.id}`
    ]?.budget_tokens;
  const configured =
    sessionBudgetOverride ??
    modelBudget ??
    settings.budget_tokens ??
    modelWindow;
  const window = Math.min(configured, modelWindow);
  return {
    configured,
    window,
    modelWindow,
    source:
      sessionBudgetOverride !== undefined
        ? "Session override"
        : modelBudget !== undefined
          ? `model override ${model.provider}/${model.id}`
          : settings.budget_tokens !== undefined
            ? "budget_tokens"
            : "model.contextWindow",
    clamped: configured > modelWindow,
  };
}

export function budgetUtilization(usage, budget, threshold) {
  return utilizationAtOrAboveThreshold(
    usage
      ? {
          ...usage,
          contextWindow: budget.window,
          ...(typeof usage.tokens === "number" ||
          budget.window !== usage.contextWindow
            ? { percent: undefined }
            : {}),
        }
      : usage,
    threshold,
  );
}

export function summaryCapsFor(compaction, model) {
  const config = compaction ?? {};
  const reserve =
    config.modelOverrides?.[`${model?.provider}/${model?.id}`]
      ?.reserveTokens ??
    config.reserveTokens ??
    16384;
  const max = model?.maxTokens ?? Infinity;
  return {
    reserve,
    history: Math.min(Math.floor(0.8 * reserve), max),
    prefix: Math.min(Math.floor(0.5 * reserve), max),
  };
}
