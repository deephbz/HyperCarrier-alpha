/** Pi-facing model adapter. It is deliberately outside the functional core. */

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function resolveRarebitModelConfiguration(config = {}) {
  if (config.modelConfigurationError) {
    return {
      ok: false,
      model: null,
      provenance: {
        source: "configuration",
        settingsKey: "rarebit.model",
        status: "invalid",
        ...config.modelProvenance,
      },
      error: String(config.modelConfigurationError),
    };
  }
  const provider = nonEmptyString(config.model?.provider);
  const id = nonEmptyString(config.model?.id);
  if (!provider || !id) {
    return {
      ok: false,
      model: null,
      provenance: {
        source: "configuration",
        settingsKey: "rarebit.model",
        status: "missing",
        ...config.modelProvenance,
      },
      error:
        "No Rarebit model resolved; set rarebit.model in Pi settings or inject config.model",
    };
  }
  return {
    ok: true,
    model: { provider, id },
    provenance: {
      source: "explicit_config",
      status: "resolved",
      ...config.modelProvenance,
    },
  };
}

export async function createPiRarebitModelClient(ctx, config = {}) {
  const { complete, getModel } = config.piAi ?? {};
  if (typeof complete !== "function")
    throw new Error(
      "Pi AI contract is unavailable; load the Rarebit Pi extension or provide modelClient/piAi",
    );
  const resolution = resolveRarebitModelConfiguration(config);
  if (!resolution.ok) throw new Error(resolution.error);
  const model =
    ctx?.modelRegistry?.find?.(
      resolution.model.provider,
      resolution.model.id,
    ) ??
    (typeof getModel === "function"
      ? getModel(resolution.model.provider, resolution.model.id)
      : undefined);
  if (!model)
    throw new Error(
      `Pi model not found: ${resolution.model.provider}/${resolution.model.id}`,
    );
  const auth = await ctx?.modelRegistry?.getApiKeyAndHeaders?.(model);
  if (!auth?.ok)
    throw new Error(
      auth?.error ??
        `No request auth for ${resolution.model.provider}/${resolution.model.id}`,
    );
  return {
    async complete(request) {
      return complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: request.prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          reasoningEffort: "low",
        },
      );
    },
  };
}

function firstNumber(response, paths) {
  for (const [source, get] of paths) {
    const value = finiteNonNegative(get(response));
    if (value !== null) return { value, source };
  }
  return { value: null, source: null };
}

function firstString(response, paths) {
  for (const [source, get] of paths) {
    const value = nonEmptyString(get(response));
    if (value) return { value, source };
  }
  return { value: null, source: null };
}

/** A bounded, machine-only provider receipt. Prompts and raw responses never enter it. */
export function extractRarebitSynthesisReceipt(
  response,
  {
    requestedModel,
    startedAt,
    completedAt,
    durationMs,
    outcome = "response",
  } = {},
) {
  const fields = {
    inputTokens: firstNumber(response, [
      ["response.usage.input", (r) => r?.usage?.input],
      ["response.usage.input_tokens", (r) => r?.usage?.input_tokens],
      ["response.usage.prompt_tokens", (r) => r?.usage?.prompt_tokens],
    ]),
    outputTokens: firstNumber(response, [
      ["response.usage.output", (r) => r?.usage?.output],
      ["response.usage.output_tokens", (r) => r?.usage?.output_tokens],
      ["response.usage.completion_tokens", (r) => r?.usage?.completion_tokens],
    ]),
    totalTokens: firstNumber(response, [
      ["response.usage.totalTokens", (r) => r?.usage?.totalTokens],
      ["response.usage.total_tokens", (r) => r?.usage?.total_tokens],
    ]),
    cacheReadTokens: firstNumber(response, [
      ["response.usage.cacheRead", (r) => r?.usage?.cacheRead],
      ["response.usage.cached_tokens", (r) => r?.usage?.cached_tokens],
    ]),
    cacheWriteTokens: firstNumber(response, [
      ["response.usage.cacheWrite", (r) => r?.usage?.cacheWrite],
    ]),
    reasoningTokens: firstNumber(response, [
      ["response.usage.reasoning", (r) => r?.usage?.reasoning],
      [
        "response.usage.output_tokens_details.reasoning_tokens",
        (r) => r?.usage?.output_tokens_details?.reasoning_tokens,
      ],
    ]),
    estimatedCostUsd: firstNumber(response, [
      ["response.usage.cost.total", (r) => r?.usage?.cost?.total],
      ["response.usage.total_cost", (r) => r?.usage?.total_cost],
    ]),
  };
  const measured = Object.values(fields).filter(
    ({ value }) => value !== null,
  ).length;
  const availability =
    measured === 0
      ? "unavailable"
      : fields.inputTokens.value !== null &&
          fields.outputTokens.value !== null &&
          fields.totalTokens.value !== null
        ? "reported"
        : "partial";
  const responseId = firstString(response, [
    ["response.responseId", (r) => r?.responseId],
    ["response.id", (r) => r?.id],
  ]);
  const requestId = firstString(response, [
    ["response.requestId", (r) => r?.requestId],
  ]);
  const responseProvider = firstString(response, [
    ["response.provider", (r) => r?.provider],
  ]);
  const responseModel = firstString(response, [
    ["response.responseModel", (r) => r?.responseModel],
    ["response.model", (r) => r?.model],
  ]);
  return {
    schemaVersion: 1,
    kind: "rarebit_model_synthesis",
    outcome,
    requestedModel: requestedModel ?? null,
    timing: {
      startedAt: startedAt ?? null,
      completedAt: completedAt ?? null,
      durationMs: finiteNonNegative(durationMs),
      provenance: "local_monotonic_clock",
    },
    provider: {
      responseProvider: responseProvider.value,
      responseProviderSource: responseProvider.source,
      responseModel: responseModel.value,
      responseModelSource: responseModel.source,
      responseId: responseId.value,
      responseIdSource: responseId.source,
      requestId: requestId.value,
      requestIdSource: requestId.source,
    },
    usage: {
      availability,
      inputTokens: fields.inputTokens.value,
      outputTokens: fields.outputTokens.value,
      totalTokens: fields.totalTokens.value,
      cacheReadTokens: fields.cacheReadTokens.value,
      cacheWriteTokens: fields.cacheWriteTokens.value,
      reasoningTokens: fields.reasoningTokens.value,
      estimatedCostUsd: fields.estimatedCostUsd.value,
      provenance: Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [name, field.source]),
      ),
    },
  };
}
