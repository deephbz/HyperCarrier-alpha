// Method work only. The controller owns admission, holds, cancellation, and pickup.
import { applyPlan, PLAN_TOOL } from "./methods/plan-apply.mjs";
import { collectToolRounds, markSuperseded, renderManifest } from "./methods/manifest.mjs";
import { FORK_APIS, forkFormat, keptFrom, readPlan } from "./methods/fork.mjs";

const OPTIONS = Object.freeze({ keepBudgetTokens: 24000, perItemTokens: 8000,
  rarebitBudgetTokens: 12000, handoffBudgetTokens: 4000, includeCustomMessages: true });
const projection = (ctx) => structuredClone(ctx.sessionManager.buildSessionProjection().entries.flatMap(
  ({ sourceEntry, messages }) => messages.map((message) => message.role === "custom"
    ? { ...sourceEntry, type: "custom_message", content: message.content }
    : { ...sourceEntry, type: "message", message })
));
/**
 * @param {string} [handoffGuidance] background artifact-handoff only: the fork also returns a
 *   handoff record. It stays in compaction context; Auto Compact writes no file.
 */
export function methodPrompt(method, rounds, background = false, handoffGuidance) {
  const handoff = background && handoffGuidance
    ? ` Also include the JSON key "handoff" (nonempty string): a handoff record of current intent, progress, decisions, unresolved work and next steps as of this point, within ${OPTIONS.handoffBudgetTokens} tokens. Guidance: ${handoffGuidance}`
    : "";
  return `This is a compaction step. Summarize goals, decisions, verified work, open questions and next actions. ${background ? "Cover only the captured prefix. Later turns remain verbatim." : "Do not continue the task."}\n${background ? `Return JSON text with the keys "summary" (string) and "keep" (array of labels).${handoff} Do not call tools.` : `Call ${PLAN_TOOL} alone as your final action with summary (string) and keep (array of labels).`} ${method === "summary" ? "Keep must be empty." : "Keep contains labels of needed tool output."}\n${renderManifest(rounds, { budgetTokens: OPTIONS.keepBudgetTokens })}`;
}
const forkHandoff = (job) => job.background && job.settings.preservation === "artifact-handoff";
export function addUsage(usages) {
  if (!usages.some(Boolean)) return undefined;
  const result = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  // These are subsets, not additional billable tokens. Preserve absence and explicit zero.
  for (const key of ["cacheWrite1h", "reasoning"])
    if (usages.some((usage) => usage?.[key] !== undefined)) result[key] = 0;
  for (const usage of usages.filter(Boolean)) {
    for (const key of Object.keys(result).filter((k) => k !== "cost")) result[key] += usage[key] ?? 0;
    for (const key of Object.keys(result.cost)) result.cost[key] += usage.cost?.[key] ?? 0;
  }
  return result;
}
export function createMethodEngine(pi) {
  let job;
  pi.events?.on("cache-goblin:placed", (placement) => {
    if (job?.background && job.phase === "armed") job.cachePlacement = placement;
  });
  const cancel = () => {
    const old = job;
    job = undefined;
    old?.controller.abort();
    if (old?.background) pi.events?.emit("cache-goblin:unpin", { name: old.pin });
  };
  const start = (ctx, settings, caps = { history: 13107 }) => {
    cancel();
    job = { settings: { ...settings }, caps, controller: new AbortController(),
      sessionId: ctx.sessionManager.getSessionId(), background: settings.execution === "background",
      phase: "armed", pin: "auto-compact-A", format: forkFormat(ctx.model?.api) };
    if (job.background) pi.events?.emit("cache-goblin:pin", { name: job.pin });
    else {
      job.entries = projection(ctx);
      job.rounds = markSuperseded(collectToolRounds(job.entries));
    }
  };
  const capture = (event, ctx) => {
    if (!job?.background || job.phase !== "armed") return;
    const format = forkFormat(ctx.model?.api);
    if (!format) throw new Error(`background does not support ${ctx.model?.api ?? "this model API"}; it requires ${FORK_APIS.join(", ")}. Use /auto-compact fg`);
    // Anthropic size probes (max_tokens 1) are not conversation requests.
    if (format.outputLimit(event.payload ?? {}) <= 1) return;
    if (event.payload?.model && event.payload.model !== ctx.model.id)
      throw new Error("background routed payload model differs from the captured model");
    const forkLimit = Math.min(format.outputLimit(event.payload) ?? Infinity, job.caps.history);
    const thinkingBudget = format.thinkingBudget(event.payload);
    if (typeof thinkingBudget === "number" && thinkingBudget >= forkLimit)
      throw new Error(`captured thinking budget ${thinkingBudget} must be below fork output cap ${forkLimit}`);
    job.base = structuredClone(event.payload);
    job.model = ctx.model;
    job.format = format;
    job.anchor = ctx.sessionManager.getLeafId();
    job.entries = projection(ctx);
    job.rounds = markSuperseded(collectToolRounds(job.entries));
    job.phase = "captured";
  };
  const request = async (ctx, current, rawPayload) => {
    const handoff = forkHandoff(current);
    const prompt = methodPrompt(current.settings.method, current.rounds, current.background,
      handoff ? current.settings.pre_compact_prompt ?? "Preserve current progress and continuation context." : undefined);
    const format = current.format;
    let payload = rawPayload ? format.build(rawPayload, prompt).payload : undefined;
    if (payload) format.capOutput(payload, current.caps.history);
    const usages = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const collector = payload ? format.collector() : undefined;
      const message = await ctx.modelRegistry.streamSimple(current.model ?? ctx.model,
        { systemPrompt: "", messages: [] }, { signal: current.controller.signal, maxRetries: 1, maxTokens: current.caps.history,
          ...(payload ? { ...format.requestOptions(payload), onPayload: () => payload, onProviderStreamEvent: (e) => collector.push(e) } : {}),
        }).result();
      usages.push(message.usage);
      if (current.controller.signal.aborted || job !== current) throw new Error("stale compaction plan");
      if (["error", "aborted"].includes(message.stopReason)) throw new Error(message.errorMessage ?? message.stopReason);
      if (["length", "max_tokens"].includes(message.stopReason))
        throw new Error("incomplete compaction plan: output limit reached");
      const plan = readPlan(message, { handoff });
      if (plan) {
        if (!plan.summary.trim()) throw new Error("planner returned empty summary");
        current.plan = plan; current.usage = addUsage(usages); current.phase = "ready"; return;
      }
      if (!payload) throw new Error("planner returned no summary");
      payload = format.continueFork(payload, collector.blocks(), `Tools are not executed. Return only complete JSON with summary (nonempty string)${handoff ? ", handoff (nonempty string)," : ""} and keep (string array).`);
    }
    throw new Error("planner returned no plan after three requests");
  };
  const launch = (event, ctx, onReady, onError) => {
    if (job?.phase !== "captured" || event.message?.role !== "assistant" ||
      !["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent?.type)) return;
    const current = job;
    current.phase = "running";
    request(ctx, current, current.base).then(() => {
      if (job === current) onReady();
    }, (error) => { if (job === current) onError(error); });
  };
  const compact = async (event, ctx) => {
    const current = job;
    if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("stale compaction session");
    if (event.signal?.aborted) throw new Error("compaction aborted");
    event.signal?.addEventListener("abort", () => current.controller.abort(), { once: true });
    if (current.controller.signal.aborted || job !== current || current.phase !== "ready") throw new Error("compaction plan not ready");
    let firstKeptEntryId;
    if (current.background) {
      const branch = ctx.sessionManager.getBranch();
      const from = keptFrom(branch, current.anchor);
      if (from.status !== "ok") throw new Error(from.status);
      firstKeptEntryId = from.firstKeptEntryId ?? undefined;
    }
    // Context edits to the captured prefix invalidate the plan. Suffix edits remain Pi-owned.
    const ids = new Set(current.entries.map((e) => e.id));
    const prefix = projection(ctx).filter((e) => ids.has(e.id));
    if (JSON.stringify(prefix) !== JSON.stringify(current.entries)) throw new Error("captured projection changed");
    const applied = applyPlan({ plan: current.plan, rounds: current.rounds,
      branchEntries: current.entries, options: { ...OPTIONS, mode: current.settings.method, anchorEntryId: current.anchor } });
    return { compaction: { summary: applied.summary, firstKeptEntryId,
      tokensBefore: event.preparation?.tokensBefore ?? 0, usage: current.usage,
      details: { autoCompact: { ...applied.details, preservation: current.settings.preservation,
        execution: current.settings.execution, anchorEntryId: current.anchor,
        cachePlacement: current.cachePlacement } } } };
  };
  const acceptPlan = (plan, ctx) => {
    if (!job || job.background || job.controller.signal.aborted ||
        typeof plan.summary !== "string" || !plan.summary.trim()) return false;
    job.entries = projection(ctx);
    const currentRounds = collectToolRounds(job.entries);
    job.rounds = job.rounds.flatMap((round) => {
      const current = currentRounds.find((item) => item.toolCallId === round.toolCallId);
      return current ? [{ ...current, label: round.label }] : [];
    });
    job.plan = { summary: String(plan.summary ?? ""), keep: Array.isArray(plan.keep) ? plan.keep.map(String) : [] };
    job.phase = "ready";
    return true;
  };
  return { start, cancel, capture, launch, compact, acceptPlan,
    prompt: () => methodPrompt(job.settings.method, job.rounds),
    phase: () => !job ? undefined : job.phase === "ready" ? "waiting to install"
      : job.background && job.phase === "armed" ? "waiting for request" : "computing",
    // null: the fork request carries no output limit.
    outputLimit: () => !job ? undefined : job.format?.capped === false ? null
      : job.base ? (Number.isFinite(job.format.outputLimit(job.base)) ? Math.min(job.format.outputLimit(job.base), job.caps.history) : null)
      : job.caps.history,
    ready: () => job?.phase === "ready" };
}
