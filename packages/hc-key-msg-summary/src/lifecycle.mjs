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
  const ui = liveUi && typeof liveUi.notify === "function"
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
 * Register Pi's lifecycle handshake for Key Message materialization.
 *
 * `input` carries origin but runs before persistence. `message_end(user)`
 * confirms a user record entered the loop, and `before_provider_request`
 * follows Pi's Session append. ESC interruption emits none of this handshake,
 * so it cannot trigger a summary. Extension-origin prompts are excluded.
 */
export function registerKeyMessageSummaryLifecycle(pi, schedule) {
  const inputOrigins = {
    direct: [],
    steer: [],
    followUp: [],
  };
  let persistedUserInputAwaitingProvider = false;
  let sessionGeneration = 0;
  let sessionLive = false;
  const MAX_PENDING_INPUT_ORIGINS = 256;

  const clearInputOrigins = () => {
    for (const queue of Object.values(inputOrigins)) queue.length = 0;
  };

  const pendingOriginCount = () =>
    Object.values(inputOrigins).reduce((total, queue) => total + queue.length, 0);

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
    for (const queue of [inputOrigins.direct, inputOrigins.steer, inputOrigins.followUp]) {
      const index = queue.findIndex((entry) => entry.text === text);
      if (index >= 0) return queue.splice(index, 1)[0];
    }
    for (const queue of [inputOrigins.direct, inputOrigins.steer, inputOrigins.followUp]) {
      if (queue.length > 0) return queue.shift();
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    clearInputOrigins();
    persistedUserInputAwaitingProvider = false;
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

  pi.on("input", (event) => {
    const bucket = event?.streamingBehavior === "steer"
      ? "steer"
      : event?.streamingBehavior === "followUp"
        ? "followUp"
        : "direct";
    inputOrigins[bucket].push({
      source: event?.source,
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
    }
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (!persistedUserInputAwaitingProvider) return;
    persistedUserInputAwaitingProvider = false;
    // Pi persists message_end(user) before this provider boundary. Snapshot
    // the evidence coordinates now so a later Session switch cannot retarget
    // an already detached materialization.
    const generation = sessionGeneration;
    schedule(
      snapshotMaterializationContext(
        ctx,
        () => sessionLive && sessionGeneration === generation,
      ),
    );
  });

  // ESC ends the agent loop with an aborted assistant message. Clear input
  // origins that never reached persistence, but never schedule from agent_end.
  pi.on("agent_end", (event) => {
    const interrupted = [...(event?.messages ?? [])].reverse().some(
      (message) => message?.role === "assistant" && message?.stopReason === "aborted",
    );
    if (interrupted) {
      clearInputOrigins();
      persistedUserInputAwaitingProvider = false;
    }
  });

  pi.on("session_shutdown", () => {
    clearInputOrigins();
    persistedUserInputAwaitingProvider = false;
    sessionLive = false;
  });
}
