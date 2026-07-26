import {
  DEFAULT_RAREBIT_SUMMARY_POLICY,
  RAREBIT_SUMMARY_LIFECYCLE_BOUNDARIES,
  RAREBIT_SUMMARY_PROMPT_VERSION,
  RAREBIT_TITLE_PROMPT_VERSION,
  composeRarebitSummaryPrompt,
  composeRarebitTitlePrompt,
  evaluateRarebitSummaryEligibility,
  measureRarebits,
  normalizeRarebitSummaryPolicy,
  normalizeRarebitSummarySynthesis,
  normalizeRarebitTitle,
  rarebitJobIdentity,
  selectRarebits,
  sha256,
  titleWithDatePrefix,
} from "./rarebit-core.mjs";
import {
  releaseRarebitJob,
  reserveRarebitJob,
  settleRarebitJob,
} from "./rarebit-store.mjs";
import {
  createPiRarebitModelClient,
  extractRarebitSynthesisReceipt,
  resolveRarebitModelConfiguration,
} from "./rarebit-model.mjs";
import {
  RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
  automaticSummaryInhibitionIdentity,
} from "./automatic-summary-policy.mjs";

export const RAREBIT_IMPLEMENTATION_VERSION = "hc-rarebit-v1";
export const RAREBIT_SUMMARY_IMPLEMENTATION_VERSION = "hc-rarebit-summary-v3";
export const RAREBIT_SUMMARY_SCHEMA_VERSION = 3;
export const DEFAULT_RAREBIT_MAX_PROMPT_CHARS = 200_000;

function sessionFileFrom(ctx) {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile.trim()
    ? sessionFile
    : null;
}

function sessionIdFrom(ctx) {
  const header = ctx?.sessionManager?.getHeader?.();
  return String(header?.id ?? ctx?.sessionId ?? "unknown-session");
}

function branchIdentity(branch) {
  const ids = (Array.isArray(branch) ? branch : []).map((entry) =>
    String(entry?.id ?? ""),
  );
  return { leafId: ids.at(-1) ?? null, entryIds: ids };
}

function extractModelText(response) {
  if (typeof response === "string") return response;
  if (typeof response?.text === "string") return response.text;
  return Array.isArray(response?.content)
    ? response.content
        .filter(
          (block) => block?.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n")
    : "";
}

function machineSelection(selection) {
  return {
    manifestHash: selection.manifestHash,
    selectorVersion: selection.manifest.selectorVersion,
    occurrenceCount: selection.occurrences.length,
    uniquePayloadCount: selection.payloads.length,
    occurrences: selection.manifest.occurrences,
    payloads: selection.manifest.payloads,
  };
}

/**
 * Shared imperative summary shell for Pi and CLI adapters. The functional core
 * decides selection, measurement, policy, prompts, and identity; this shell
 * owns only model invocation and append-only derived-record persistence.
 */
export async function processRarebitSummary(ctx, config = {}) {
  const branch = ctx?.sessionManager?.getBranch?.() ?? config.branch ?? [];
  const sessionFile = config.sessionFile ?? sessionFileFrom(ctx);
  const sessionId = config.sessionId ?? sessionIdFrom(ctx);
  const selection = selectRarebits(branch);
  const measurement = measureRarebits(branch, selection);
  const policy = normalizeRarebitSummaryPolicy(
    config.summaryPolicy ?? DEFAULT_RAREBIT_SUMMARY_POLICY,
  );
  const eligibility = evaluateRarebitSummaryEligibility(measurement, policy);
  const forceSynthesis = config.forceSynthesis === true;
  const synthesisMode = forceSynthesis ? "forced" : "automatic";
  const lifecycleBoundary =
    config.lifecycleBoundary ?? (forceSynthesis ? "manual" : "session_start");
  if (!RAREBIT_SUMMARY_LIFECYCLE_BOUNDARIES.includes(lifecycleBoundary))
    throw new TypeError("Unsupported Summary lifecycle boundary");
  const branchRef = branchIdentity(branch);
  let automaticSummaryPolicy = {
    decision: "abstain",
    queryStatus: forceSynthesis
      ? "forced_request"
      : eligibility.eligible
        ? "provider_absent"
        : "intrinsically_ineligible",
    contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
  };
  let inhibitionIdentity = null;
  if (
    eligibility.eligible &&
    !forceSynthesis &&
    typeof config.queryAutomaticSummaryPolicy === "function"
  ) {
    try {
      const queried = await config.queryAutomaticSummaryPolicy({
        sessionId,
        durableAssociation: sessionFile,
      });
      const queriedIdentity = automaticSummaryInhibitionIdentity(queried);
      if (queried?.decision === "inhibit" && queriedIdentity) {
        automaticSummaryPolicy = queried;
        inhibitionIdentity = queriedIdentity;
      } else if (queried?.decision === "abstain")
        automaticSummaryPolicy = queried;
    } catch {
      automaticSummaryPolicy = {
        decision: "abstain",
        queryStatus: "provider_failure",
        contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
      };
    }
  }
  const inhibited = inhibitionIdentity !== null;
  const shouldSynthesize =
    (eligibility.eligible && !inhibited) || forceSynthesis;
  const modelResolution = shouldSynthesize
    ? resolveRarebitModelConfiguration(config)
    : {
        ok: true,
        model: null,
        provenance: { source: "not_required", status: "not_required" },
      };
  const promptVersion = config.promptVersion ?? RAREBIT_SUMMARY_PROMPT_VERSION;
  const maxPromptChars =
    config.maxPromptChars ?? DEFAULT_RAREBIT_MAX_PROMPT_CHARS;
  if (!Number.isInteger(maxPromptChars) || maxPromptChars < 1)
    throw new RangeError("maxPromptChars must be a positive integer");
  const inputCoveragePolicy = {
    strategy: "complete_or_explicit_overflow",
    maxPromptChars,
  };
  const synthesisJobId = rarebitJobIdentity({
    operation: "summary",
    mode: synthesisMode,
    sessionId,
    branch: branchRef,
    selection,
    policy,
    inputPolicy: inputCoveragePolicy,
    lifecycleBoundary,
    promptVersion,
    model: modelResolution.model,
  });
  const jobId = inhibited
    ? sha256({
        version: "rarebit-automatic-summary-inhibition-job-v1",
        synthesisJobId,
        policy: inhibitionIdentity,
      })
    : synthesisJobId;
  const base = {
    schemaVersion: RAREBIT_SUMMARY_SCHEMA_VERSION,
    type: "rarebit_summary",
    status: inhibited
      ? "inhibited"
      : shouldSynthesize
        ? "pending"
        : "ineligible",
    implementationVersion:
      config.implementationVersion ?? RAREBIT_SUMMARY_IMPLEMENTATION_VERSION,
    synthesisMode,
    lifecycleBoundary,
    inputCoveragePolicy,
    jobId,
    sessionId,
    branch: branchRef,
    observedAt: new Date().toISOString(),
    selection: machineSelection(selection),
    measurement,
    eligibility: {
      ...eligibility,
      forced: forceSynthesis && !eligibility.eligible,
    },
    model: modelResolution.model,
    modelProvenance: modelResolution.provenance,
    promptVersion,
    ...(inhibited ? { automaticSummaryPolicy } : {}),
  };
  if (!sessionFile) {
    return {
      duplicate: false,
      skipped: true,
      record: {
        ...base,
        status: "skipped_ephemeral_session",
        reason: "ephemeral_session",
      },
    };
  }
  const reservation = await reserveRarebitJob({
    jobId,
    sessionFile,
    rarebitRoot: config.rarebitRoot,
    sessionRoot: config.sessionRoot,
    allowExternalSession: config.allowExternalSession === true,
    leaseMs: config.leaseMs,
  });
  if (!reservation.acquired)
    return {
      duplicate: reservation.duplicate === true,
      inFlight: reservation.inFlight === true,
      record: reservation.record ?? base,
      reservation,
    };
  try {
    if (!shouldSynthesize)
      return {
        duplicate: false,
        record: await settleRarebitJob(reservation, base),
      };
    if (!modelResolution.ok) {
      return {
        duplicate: false,
        record: await settleRarebitJob(reservation, {
          ...base,
          status: "failure",
          retryable: false,
          error: {
            name: "ModelConfigurationError",
            message: modelResolution.error,
          },
        }),
      };
    }
    const prompt = composeRarebitSummaryPrompt(selection, {
      promptVersion,
      lifecycleBoundary,
    });
    if (prompt.length > maxPromptChars) {
      return {
        duplicate: false,
        record: await settleRarebitJob(reservation, {
          ...base,
          status: "unavailable_overflow",
          overflow: {
            promptChars: prompt.length,
            maxPromptChars,
            strategy: "none",
          },
        }),
      };
    }
    await config.onSynthesisTriggered?.({
      sessionId,
      sessionFile,
      branchLeafId: branchRef.leafId,
      eligibility: base.eligibility,
      rarebitCount: selection.occurrences.length,
      model: modelResolution.model,
      estimatedInputTokens: Math.ceil(prompt.length / 4),
      inputTokenEstimateMethod: "utf16_chars_div_4_ceil",
    });
    const client =
      config.modelClient ?? (await createPiRarebitModelClient(ctx, config));
    const startedAt = new Date().toISOString();
    const startedMonotonic = process.hrtime.bigint();
    const response = await client.complete({
      prompt,
      model: modelResolution.model,
    });
    const synthesisResult = normalizeRarebitSummarySynthesis(
      extractModelText(response),
    );
    if (
      synthesisResult.sessionStatus === "user_requested" &&
      lifecycleBoundary !== "owner_request"
    )
      throw new TypeError(
        "user_requested is legal only at the owner_request lifecycle boundary",
      );
    return {
      duplicate: false,
      record: await settleRarebitJob(reservation, {
        ...base,
        status: "ok",
        summary: synthesisResult.summary,
        sessionStatus:
          lifecycleBoundary === "owner_request"
            ? "user_requested"
            : synthesisResult.sessionStatus,
        statusReason:
          lifecycleBoundary === "owner_request"
            ? "owner_request_recorded"
            : synthesisResult.statusReason,
        synthesis: extractRarebitSynthesisReceipt(response, {
          requestedModel: modelResolution.model,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Number(process.hrtime.bigint() - startedMonotonic) / 1e6,
        }),
      }),
    };
  } catch (error) {
    const record = {
      ...base,
      status: "failure",
      retryable: true,
      error: {
        name: error?.name ?? "Error",
        message: String(error?.message ?? error),
      },
    };
    try {
      return {
        duplicate: false,
        record: await settleRarebitJob(reservation, record),
      };
    } catch (settleError) {
      await releaseRarebitJob(reservation);
      throw settleError;
    }
  }
}

function selectTitleEvidence(
  branch,
  { sourceEntryId, sourceText, allowFirstUserFallback = false } = {},
) {
  const fullSelection = selectRarebits(branch);
  const occurrence = sourceEntryId
    ? fullSelection.occurrences.find(
        (candidate) =>
          candidate.sourceEntryId === sourceEntryId &&
          candidate.outcome === "user",
      )
    : typeof sourceText === "string"
      ? [...fullSelection.occurrences]
          .reverse()
          .find(
            (candidate) =>
              candidate.outcome === "user" && candidate.text === sourceText,
          )
      : allowFirstUserFallback
        ? fullSelection.occurrences.find(
            (candidate) => candidate.outcome === "user",
          )
        : null;
  if (!occurrence) return { fullSelection, occurrence: null, selection: null };
  return {
    fullSelection,
    occurrence,
    selection: selectRarebits([branch[occurrence.order]]),
  };
}

/**
 * Shared imperative title shell for Pi and CLI adapters. The caller supplies
 * only evidence coordinates, date, and an optional label-application adapter;
 * selection, prompt composition, model invocation, durable dedupe, and the
 * derived receipt are identical across both interfaces.
 */
export async function processRarebitTitle(ctx, config = {}) {
  const branch = ctx?.sessionManager?.getBranch?.() ?? config.branch ?? [];
  const sessionFile = config.sessionFile ?? sessionFileFrom(ctx);
  const sessionId = config.sessionId ?? sessionIdFrom(ctx);
  const branchRef = branchIdentity(branch);
  const { occurrence, selection } = selectTitleEvidence(branch, {
    sourceEntryId: config.sourceEntryId,
    sourceText: config.sourceText,
    allowFirstUserFallback: config.allowFirstUserFallback === true,
  });
  if (!occurrence || !selection) {
    return {
      duplicate: false,
      skipped: true,
      record: {
        schemaVersion: 1,
        type: "rarebit_title",
        status: "skipped_owner_evidence_not_found",
        sessionId,
        branch: branchRef,
        observedAt: new Date().toISOString(),
      },
    };
  }
  if (!sessionFile) {
    return {
      duplicate: false,
      skipped: true,
      record: {
        schemaVersion: 1,
        type: "rarebit_title",
        status: "skipped_ephemeral_session",
        sessionId,
        branch: branchRef,
        observedAt: new Date().toISOString(),
      },
    };
  }

  const modelResolution = resolveRarebitModelConfiguration(config);
  const applicationMode =
    typeof config.applyTitle === "function" ? "apply" : "proposal";
  const promptVersion = config.promptVersion ?? RAREBIT_TITLE_PROMPT_VERSION;
  const jobId = rarebitJobIdentity({
    operation: "title",
    mode: `${applicationMode}:${config.requestIdentity ?? "stable"}`,
    sessionId,
    branch: branchRef,
    selection,
    promptVersion,
    model: modelResolution.model,
  });
  const base = {
    schemaVersion: 1,
    type: "rarebit_title",
    status: "pending",
    jobId,
    implementationVersion:
      config.implementationVersion ?? RAREBIT_IMPLEMENTATION_VERSION,
    sessionId,
    branch: branchRef,
    selectionManifestHash: selection.manifestHash,
    titleEvidence: {
      provenance:
        config.evidenceProvenance ??
        (config.allowFirstUserFallback
          ? "branch_user_fallback"
          : "captured_interactive_rpc"),
      sourceEntryId: occurrence.sourceEntryId,
    },
    promptVersion,
    model: modelResolution.model,
    modelProvenance: modelResolution.provenance,
    applicationMode,
    priorTitle: config.priorTitle ?? null,
    title: null,
    observedAt: new Date().toISOString(),
  };
  const reservation = await reserveRarebitJob({
    jobId,
    sessionFile,
    rarebitRoot: config.rarebitRoot,
    sessionRoot: config.sessionRoot,
    allowExternalSession: config.allowExternalSession === true,
    leaseMs: config.leaseMs,
  });
  if (!reservation.acquired)
    return {
      duplicate: reservation.duplicate === true,
      inFlight: reservation.inFlight === true,
      record: reservation.record ?? base,
      reservation,
    };
  try {
    if (!modelResolution.ok) {
      return {
        duplicate: false,
        record: await settleRarebitJob(reservation, {
          ...base,
          status: "failure",
          retryable: false,
          error: {
            name: "ModelConfigurationError",
            message: modelResolution.error,
          },
        }),
      };
    }
    const client =
      config.titleModelClient ??
      config.modelClient ??
      (await createPiRarebitModelClient(ctx, config));
    const startedAt = new Date().toISOString();
    const startedMonotonic = process.hrtime.bigint();
    const response = await client.complete({
      prompt: composeRarebitTitlePrompt(selection, { promptVersion }),
      model: modelResolution.model,
    });
    const proposed = normalizeRarebitTitle(extractModelText(response));
    const title = titleWithDatePrefix(proposed, { date: config.titleDate });
    const application =
      applicationMode === "apply"
        ? await config.applyTitle({
            title,
            priorTitle: base.priorTitle,
            sessionId,
            sessionFile,
            sourceEntryId: occurrence.sourceEntryId,
          })
        : { status: "proposal" };
    const status =
      application?.status ??
      (applicationMode === "apply" ? "failure" : "proposal");
    const appliedOrProposedTitle =
      status === "applied" || status === "proposal" ? title : null;
    return {
      duplicate: false,
      record: await settleRarebitJob(reservation, {
        ...base,
        status,
        title: appliedOrProposedTitle,
        synthesis: extractRarebitSynthesisReceipt(response, {
          requestedModel: modelResolution.model,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Number(process.hrtime.bigint() - startedMonotonic) / 1e6,
        }),
      }),
    };
  } catch (error) {
    const record = {
      ...base,
      status: "failure",
      retryable: true,
      error: {
        name: error?.name ?? "Error",
        message: String(error?.message ?? error),
      },
    };
    try {
      return {
        duplicate: false,
        record: await settleRarebitJob(reservation, record),
      };
    } catch (settleError) {
      await releaseRarebitJob(reservation);
      throw settleError;
    }
  }
}
