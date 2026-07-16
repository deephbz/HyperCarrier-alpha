function isUserSubmissionOrigin(event) {
  return event?.source === "interactive" || event?.source === "rpc";
}

function isUserMessage(event) {
  return event?.message?.role === "user";
}

function messageText(event) {
  const content = event?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function snapshotMaterializationContext(ctx, mayNotify = () => true) {
  const sessionManager = ctx?.sessionManager;
  const header = sessionManager?.getHeader?.();
  const branch = sessionManager?.getBranch?.();
  const branchSnapshot = Array.isArray(branch) ? branch.slice() : [];
  const sessionFile = sessionManager?.getSessionFile?.();
  const projectTrusted = ctx?.isProjectTrusted?.() === true;
  const liveUi = ctx?.ui;
  const ui =
    liveUi && typeof liveUi.notify === "function"
      ? {
          notify: (...args) => {
            if (mayNotify()) liveUi.notify(...args);
          },
        }
      : liveUi;
  return {
    cwd: ctx?.cwd,
    hasUI: ctx?.hasUI,
    ui,
    modelRegistry: ctx?.modelRegistry,
    sessionId: ctx?.sessionId,
    isProjectTrusted: () => projectTrusted,
    sessionManager: {
      getHeader: () => header,
      getBranch: () => branchSnapshot.slice(),
      getSessionFile: () => sessionFile,
    },
  };
}

/**
 * Run at most one materialization at a time without returning its Promise to
 * Pi's awaited extension hook chain. Triggers that arrive while a run is in
 * flight collapse into one rerun against the latest ExtensionContext.
 */
export function createDetachedMaterializer(materialize, onError = () => {}) {
  let running = false;
  let queued = false;
  let latestContext;

  const drain = async () => {
    try {
      while (queued) {
        const ctx = latestContext;
        queued = false;
        latestContext = undefined;
        try {
          await materialize(ctx);
        } catch (error) {
          try {
            onError(error, ctx);
          } catch {
            // Error reporting is best-effort and must never create an
            // unhandled rejection or re-enter Pi's lifecycle chain.
          }
        }
      }
    } finally {
      running = false;
      // Preserve a trigger that arrived after the loop observed `queued` but
      // before this finally block ran.
      if (queued) kick();
    }
  };

  const kick = () => {
    if (running) return;
    running = true;
    // Yield a full event-loop turn. A microtask would let synchronous branch
    // selection run before Pi resumes its provider/TUI foreground pipeline.
    setImmediate(() => {
      void drain();
    });
  };

  return (ctx) => {
    latestContext = ctx;
    queued = true;
    kick();
  };
}

/**
 * Register Pi's lifecycle handshake for Rarebit materialization.
 *
 * `input` carries origin but runs before persistence. `message_end(user)`
 * confirms a user record entered the loop, and `before_provider_request`
 * follows Pi's Session append. `agent_end` records whether its terminal
 * assistant stopped normally; `agent_settled` captures the complete branch
 * only after Pi has exhausted retries, compaction, and queued continuations.
 * ESC instead ends in an `aborted` assistant message and never creates a
 * settlement checkpoint.
 * Extension-origin prompts are excluded from the user-submission trigger.
 */
export function registerRarebitLifecycle(pi, schedule, options = {}) {
  const inputOrigins = {
    direct: [],
    steer: [],
    followUp: [],
  };
  let persistedUserInputAwaitingProvider = false;
  let normalStopAwaitingSettlement = false;
  let firstOwnerInputAwaitingProvider;
  let ownerMessageSeen = false;
  let sessionGeneration = 0;
  let sessionLive = false;
  const MAX_PENDING_INPUT_ORIGINS = 256;

  const clearInputOrigins = () => {
    for (const queue of Object.values(inputOrigins)) queue.length = 0;
  };

  const pendingOriginCount = () =>
    Object.values(inputOrigins).reduce(
      (total, queue) => total + queue.length,
      0,
    );

  const pruneOldestOrigin = () => {
    const candidates = Object.values(inputOrigins)
      .filter((queue) => queue.length > 0)
      .sort((left, right) => left[0].sequence - right[0].sequence);
    candidates[0]?.shift();
  };

  let inputSequence = 0;
  const consumeInputOrigin = (text) => {
    // Prefer an exact semantic payload match. If skill/template expansion
    // changed the text, fall back to Pi's delivery order: direct prompt first,
    // then every steer before follow-ups.
    for (const queue of [
      inputOrigins.direct,
      inputOrigins.steer,
      inputOrigins.followUp,
    ]) {
      const index = queue.findIndex((entry) => entry.text === text);
      if (index >= 0) return queue.splice(index, 1)[0];
    }
    for (const queue of [
      inputOrigins.direct,
      inputOrigins.steer,
      inputOrigins.followUp,
    ]) {
      if (queue.length > 0) return queue.shift();
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    options.onSessionStart?.(ctx);
    clearInputOrigins();
    persistedUserInputAwaitingProvider = false;
    normalStopAwaitingSettlement = false;
    firstOwnerInputAwaitingProvider = undefined;
    ownerMessageSeen = (ctx?.sessionManager?.getBranch?.() ?? []).some(
      (entry) => entry?.type === "message" && entry?.message?.role === "user",
    );
    sessionGeneration += 1;
    sessionLive = true;
    const generation = sessionGeneration;
    schedule(
      snapshotMaterializationContext(
        ctx,
        () => sessionLive && sessionGeneration === generation,
      ),
    );
  });

  pi.on("agent_start", () => {
    // A retry, compaction pass, or queued continuation starts a new agent run;
    // an earlier stop is not the fully settled branch.
    normalStopAwaitingSettlement = false;
  });

  pi.on("input", (event) => {
    const bucket =
      event?.streamingBehavior === "steer"
        ? "steer"
        : event?.streamingBehavior === "followUp"
          ? "followUp"
          : "direct";
    inputOrigins[bucket].push({
      source: event?.source,
      bucket,
      text: typeof event?.text === "string" ? event.text : "",
      sequence: inputSequence,
    });
    inputSequence += 1;
    if (pendingOriginCount() > MAX_PENDING_INPUT_ORIGINS) pruneOldestOrigin();
  });

  pi.on("message_end", (event) => {
    if (!isUserMessage(event)) return;
    const origin = consumeInputOrigin(messageText(event));
    if (isUserSubmissionOrigin(origin)) {
      persistedUserInputAwaitingProvider = true;
      if (!ownerMessageSeen && origin.bucket === "direct") {
        ownerMessageSeen = true;
        firstOwnerInputAwaitingProvider = {
          text: messageText(event),
          source: origin.source,
          sourceEntryId:
            typeof event?.message?.id === "string"
              ? event.message.id
              : typeof event?.id === "string"
                ? event.id
                : null,
        };
      }
    }
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (!persistedUserInputAwaitingProvider) return;
    persistedUserInputAwaitingProvider = false;
    // Pi persists message_end(user) before this provider boundary. Snapshot
    // the evidence coordinates now so a later Session switch cannot retarget
    // an already detached materialization.
    const generation = sessionGeneration;
    const snapshot = snapshotMaterializationContext(
      ctx,
      () => sessionLive && sessionGeneration === generation,
    );
    schedule(snapshot);
    if (firstOwnerInputAwaitingProvider) {
      const ownerMessage = firstOwnerInputAwaitingProvider;
      firstOwnerInputAwaitingProvider = undefined;
      try {
        options.onFirstPersistedOwnerMessage?.(snapshot, ownerMessage);
      } catch {
        // Auto-title is a detached human-facing projection. Failure must not
        // enter Pi's provider path or change summary settlement.
      }
    }
  });

  pi.on("agent_end", (event) => {
    // Record the latest run outcome, but do not project yet: Pi may still
    // retry, compact, or drain a continuation before `agent_settled`.
    const terminalAssistant = [...(event?.messages ?? [])]
      .reverse()
      .find((message) => message?.role === "assistant");
    normalStopAwaitingSettlement = terminalAssistant?.stopReason === "stop";
    if (terminalAssistant?.stopReason === "aborted") {
      clearInputOrigins();
      persistedUserInputAwaitingProvider = false;
      firstOwnerInputAwaitingProvider = undefined;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!normalStopAwaitingSettlement) return;
    normalStopAwaitingSettlement = false;

    const generation = sessionGeneration;
    schedule(
      snapshotMaterializationContext(
        ctx,
        () => sessionLive && sessionGeneration === generation,
      ),
    );
  });

  pi.on("session_shutdown", () => {
    clearInputOrigins();
    persistedUserInputAwaitingProvider = false;
    firstOwnerInputAwaitingProvider = undefined;
    normalStopAwaitingSettlement = false;
    sessionLive = false;
    options.onSessionShutdown?.();
  });
}
