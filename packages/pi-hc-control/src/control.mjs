// Session control core: validates frames, honors compaction and C1 delivery
// holds, submits owner input through Pi, runs typed slash commands, and
// acknowledges only what Pi showed.
// Transport-free so it runs under the real SDK in pi-sim.

export const HOLD_CHANNEL = "hc.delivery-hold";
export const MAX_TEXT_BYTES = 1024 * 1024;
export const DEFAULTS = Object.freeze({
  holdWaitMs: 120_000,
  admitTimeoutMs: 30_000,
  abortTimeoutMs: 30_000,
  pollMs: 50,
  // Settled submissions kept in status, so a client that polls sees each outcome.
  keepSettled: 20,
  // Same fail-open leases as Pi Team Bright's delivery gate.
  externalHoldLimitMs: 30 * 60_000,
  compactionHoldLimitMs: 15 * 60_000,
});

const DELIVER_AS = new Set(["steer", "followUp"]);
// Pi 1.3.0 built-ins (core/slash-commands.js; not exported). Only the TUI runs them, so the
// control maps the ones with a typed extension API and refuses the rest.
const BUILTINS = [
  ["model", "Set the model", "<provider/model>"],
  ["thinking", "Set the thinking level", "<level>"],
  ["name", "Set the Session display name", "<name>"],
  ["compact", "Compact the Session context", "[instructions]"],
];
const PANE_ONLY = ["settings", "tree", "scoped-models", "export", "import", "share", "bug", "copy", "session",
  "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "resume", "reload", "quit"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const NAME = /^[A-Za-z0-9][\w:.-]*$/;
const KEEP_KEYS = 100;
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
      : "";

const fail = (id, code, message, extra) => ({ id, ok: false, error: { code, message, ...extra } });
const refOf = (model) => (model ? `${model.provider}/${model.id}` : null);
// Status carries each tracked text so a client can recover it; a longer text is clipped and marked.
export const STATUS_TEXT_BYTES = 16 * 1024;
const clipped = (text) => {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= STATUS_TEXT_BYTES
    ? { text }
    : { text: bytes.subarray(0, STATUS_TEXT_BYTES).toString("utf8").replace(/\uFFFD$/, ""), truncated: true };
};

export function createControl(pi, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const timers = () => cfg.timers ?? globalThis;
  const later = (fn, ms) => timers().setTimeout(fn, ms);
  const cancel = (handle) => handle !== undefined && timers().clearTimeout(handle);
  const sleep = (ms) => new Promise((resolve) => later(resolve, ms));

  let ctx;
  let identity = {};
  let closed = false;
  let runActive = false;
  let compacting = false;
  let settling = false;
  let compactionLimit;
  const holds = new Map(); // token -> { holder, timer }
  const waiters = new Set();
  const queue = { steer: [], followUp: [] }; // mirror of Pi's user queue
  // Submissions this control put into Pi's queue, until their outcome is known (P7: admission is not delivery).
  // state: queued -> delivered (Pi started the user message) | returned (left the queue undelivered and the
  // editor draft holds the text, as Pi's abort and dequeue do) | dropped (left it undelivered, not in the editor).
  const submissions = [];
  let inflight;
  let chain = Promise.resolve();

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const held = () => compacting || settling || holds.size > 0 || piCompacting();
  // Pi is idle only without a run and without compaction or branch summary.
  const piCompacting = () => Boolean(ctx) && !runActive && !ctx.isIdle();

  const endCompaction = () => {
    if (!compacting) return;
    compacting = false;
    cancel(compactionLimit);
    compactionLimit = undefined;
    // Pi emits session_compact(_failed) before it clears its compaction state.
    settling = true;
    later(() => {
      settling = false;
      wake();
    }, 0);
  };

  const releaseHold = (token) => {
    const hold = holds.get(token);
    if (!hold) return;
    cancel(hold.timer);
    holds.delete(token);
    wake();
  };

  const reconcileQueue = () => {
    if (ctx && !ctx.hasPendingMessages()) {
      queue.steer.length = 0;
      queue.followUp.length = 0;
    }
  };

  // An emptied queue proves no delivery while a run can still be taking the message; decide once Pi is idle.
  const settleQueued = () => {
    if (!ctx || !ctx.isIdle() || ctx.hasPendingMessages()) return [];
    const settled = [];
    let editor;
    for (const record of submissions) {
      if (record.state !== "queued") continue;
      editor ??= String(ctx.ui?.getEditorText?.() ?? "");
      // A queued skill or template reaches Pi as different text, so delivery is not observable.
      record.state = editor.includes(record.text) ? "returned" : record.expanded ? "unknown" : "dropped";
      record.at = Date.now();
      settled.push(record);
    }
    let excess = submissions.filter((r) => r.state !== "queued").length - cfg.keepSettled;
    for (let i = 0; excess > 0 && i < submissions.length; )
      if (submissions[i].state !== "queued") {
        submissions.splice(i, 1);
        excess--;
      } else i++;
    return settled;
  };
  const view = ({ submission, deliverAs, text, state, at, entryId, expanded }) => ({
    submission,
    deliverAs,
    state,
    at,
    ...(expanded ? { expanded } : {}),
    ...(entryId ? { entryId } : {}),
    ...clipped(text),
  });

  const reset = () => {
    for (const token of [...holds.keys()]) releaseHold(token);
    cancel(compactionLimit);
    compacting = settling = runActive = false;
    queue.steer.length = queue.followUp.length = 0;
    submissions.length = 0;
  };

  pi.events?.on?.(HOLD_CHANNEL, (signal) => {
    if (!signal || typeof signal !== "object") return;
    const { holder, token, active } = signal;
    if (typeof holder !== "string" || !holder.trim()) return;
    if (typeof token !== "string" || !token.trim() || typeof active !== "boolean") return;
    const previous = holds.get(token);
    if (previous && previous.holder !== holder) return;
    if (!active) return releaseHold(token);
    cancel(previous?.timer);
    const hold = { holder, timer: undefined };
    holds.set(token, hold);
    hold.timer = later(() => {
      if (holds.get(token) === hold) releaseHold(token);
    }, cfg.externalHoldLimitMs);
    hold.timer?.unref?.();
  });

  pi.on("session_before_compact", () => {
    compacting = true;
    cancel(compactionLimit);
    compactionLimit = later(endCompaction, cfg.compactionHoldLimitMs);
    compactionLimit?.unref?.();
  });
  pi.on("session_compact", endCompaction);
  pi.on("session_compact_failed", endCompaction);
  pi.on("agent_start", () => {
    runActive = true;
  });
  pi.on("agent_settled", () => {
    runActive = false;
    reconcileQueue();
    settleQueued();
    wake();
  });

  pi.on("input", (event) => {
    if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp")
      queue[event.streamingBehavior].push(event.text);
    if (inflight && !inflight.inputSeen && event.source === "extension" && event.text === inflight.text) {
      inflight.inputSeen = event.streamingBehavior ?? "start";
      if (inflight.inputSeen !== "start") {
        inflight.record = { submission: globalThis.crypto.randomUUID(), deliverAs: inflight.inputSeen, text: event.text, state: "queued", at: Date.now(), ...(inflight.expand ? { expanded: true } : {}) };
        submissions.push(inflight.record);
        inflight.checkQueued();
      }
    }
  });

  pi.on("message_start", (event) => {
    if (event.message?.role !== "user") return;
    const text = textOf(event.message.content);
    for (const kind of ["steer", "followUp"]) {
      const index = queue[kind].indexOf(text);
      if (index !== -1) {
        queue[kind].splice(index, 1);
        break;
      }
    }
    const record = submissions.find((r) => r.state === "queued" && r.text === text);
    if (record) Object.assign(record, { state: "delivered", at: Date.now(), message: event.message });
    if (!inflight?.inputSeen) return;
    if (inflight.inputSeen === "start" && !inflight.userMessage) inflight.userMessage = event.message;
    else if (inflight.inputSeen !== "start" && text === inflight.text) inflight.settle({ evidence: "admitted" });
  });

  // Pi persists the user entry right after extensions see message_end.
  const entryIdOf = (message) => {
    const entries = ctx?.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--)
      if (entries[i].type === "message" && entries[i].message === message) return entries[i].id;
  };

  pi.on("message_end", (event) => {
    const record = submissions.find((r) => r.message && r.message === event.message);
    if (record)
      later(() => {
        record.entryId = entryIdOf(record.message);
        record.message = undefined;
      }, 0);
    if (!inflight?.userMessage || event.message !== inflight.userMessage) return;
    const current = inflight;
    later(() => {
      const entryId = entryIdOf(current.userMessage);
      current.settle({ evidence: "started", ...(entryId ? { entryId } : {}) });
    }, 0);
  });

  const waitOpen = async (deadline) => {
    while (held()) {
      if (closed) return "closed";
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout";
      await new Promise((resolve) => {
        let timer;
        const done = () => {
          waiters.delete(done);
          cancel(timer);
          resolve();
        };
        waiters.add(done);
        // Poll as a backstop for Pi-internal compaction without events.
        timer = later(done, Math.min(remaining, cfg.pollMs * 20));
      });
    }
    return closed ? "closed" : "open";
  };

  const deliver = (text, deliverAs, expand) =>
    new Promise((resolve) => {
      let done = false;
      let timer;
      let poll;
      const attempt = {
        text,
        expand,
        inputSeen: undefined,
        userMessage: undefined,
        settle(value) {
          if (done) return;
          done = true;
          if (attempt.record) {
            // A refused attempt never reached Pi's queue; an admitted one names its record.
            if (value.error) submissions.splice(submissions.indexOf(attempt.record), 1);
            else value = { ...value, submission: attempt.record.submission };
          }
          cancel(timer);
          cancel(poll);
          if (inflight === attempt) inflight = undefined;
          resolve(value);
        },
        checkQueued() {
          // Pi pushes to its queue right after the input handlers return.
          poll = later(function check() {
            if (done) return;
            if (ctx?.hasPendingMessages()) return attempt.settle({ evidence: "admitted" });
            poll = later(check, cfg.pollMs);
          }, 0);
        },
      };
      const arm = () => {
        timer = later(() => {
          if (done) return;
          if (compacting || settling) return arm(); // Pi may compact before starting a turn.
          attempt.settle({
            error: "not_admitted",
            message: attempt.inputSeen
              ? "Pi took the input but showed no user entry; see Pi's error notice in the pane."
              : "Pi did not take the input; see Pi's error notice in the pane.",
          });
        }, cfg.admitTimeoutMs);
      };
      inflight = attempt;
      attempt.closeOut = () => attempt.settle({ error: "closed", message: "Session control closed." });
      arm();
      try {
        pi.sendUserMessage(text, { deliverAs, ...(expand ? { expandPromptTemplates: true } : {}) });
      } catch (error) {
        attempt.settle({ error: "not_admitted", message: String(error?.message ?? error) });
      }
    });

  const submit = async (id, text, deliverAs, arrived, expand = false) => {
    const gate = await waitOpen(arrived + cfg.holdWaitMs);
    if (gate === "closed") return fail(id, "closed", "Session control closed.");
    if (gate === "timeout")
      return fail(id, "busy_compacting", `Compaction or a delivery hold did not clear within ${cfg.holdWaitMs} ms.`);
    const result = await deliver(text, deliverAs, expand);
    if (result.error) return fail(id, result.error, result.message);
    return { id, ok: true, ...result };
  };

  const abort = async (id) => {
    if (!ctx || ctx.isIdle()) return { id, ok: true, evidence: "idle" };
    // agent_settled may settle these before this loop sees idle; report them by identity.
    const queued = submissions.filter((r) => r.state === "queued");
    ctx.abort();
    const deadline = Date.now() + cfg.abortTimeoutMs;
    while (!ctx.isIdle()) {
      if (Date.now() >= deadline) return fail(id, "abort_timeout", "Pi did not become idle after abort.");
      await sleep(cfg.pollMs);
    }
    // Pi's interactive abort moves queued input into the editor draft; name each submission it took back.
    settleQueued();
    return { id, ok: true, evidence: "aborted", ...(queued.length ? { submissions: queued.map(view) } : {}) };
  };

  const compactingNow = () => compacting || settling || piCompacting();
  const usableModels = () => {
    const scoped = ctx.scopedModels ?? [];
    return scoped.length ? scoped.map((s) => s.model) : (ctx.modelRegistry?.getAvailable?.() ?? []);
  };
  const thinkingLevels = () => (ctx.model?.reasoning ? THINKING_LEVELS : ["off"]);
  // Built-ins first, as in Pi's TUI; then what Pi registers now (extension, prompt, skill).
  const listCommands = () => [
    ...BUILTINS.map(([name, description, argsHint]) => ({ name, description, argsHint, source: "builtin", supported: true })),
    ...PANE_ONLY.map((name) => ({ name, source: "builtin", supported: false })),
    ...pi
      .getCommands()
      .filter((c) => !BUILTINS.some(([b]) => b === c.name) && !PANE_ONLY.includes(c.name))
      .map(({ name, description, source }) => ({ name, ...(description ? { description } : {}), source, supported: true })),
  ];
  const commands = () => ({
    commands: listCommands(),
    models: usableModels().map((m) => ({ ref: refOf(m), ...(m.name ? { name: m.name } : {}) })),
    model: refOf(ctx.model),
    thinkingLevels: thinkingLevels(),
    thinking: pi.getThinkingLevel(),
  });

  // Exact provider/id, or a bare id that names one model, as Pi's TUI /model does (no fuzzy match).
  const matchModel = (ref) => {
    const models = usableModels();
    const slash = ref.indexOf("/");
    const exact = slash > 0 && models.find((m) => m.provider === ref.slice(0, slash) && m.id === ref.slice(slash + 1));
    if (exact) return { model: exact };
    const bare = models.filter((m) => m.id === ref);
    return bare.length === 1 ? { model: bare[0] } : { matches: bare.map(refOf) };
  };

  const builtin = {
    async model(id, args) {
      if (!args) return fail(id, "bad_args", "Name a model: /model <provider/id>.");
      const { model, matches } = matchModel(args);
      if (!model)
        return matches.length
          ? fail(id, "bad_args", `"${args}" names ${matches.length} models; use one of: ${matches.join(", ")}.`, { matches })
          : fail(id, "bad_args", `No available model matches "${args}".`, { matches });
      const busy = !ctx.isIdle();
      if (!(await pi.setModel(model))) return fail(id, "auth_missing", `No credentials for ${refOf(model)}.`);
      const ref = refOf(model);
      // Pi switches at once; a running turn uses the model from its next model call.
      return handled(id, `Model: ${ref}${busy ? " (from Pi's next model call)" : ""}`, { model: ref });
    },
    async thinking(id, args) {
      if (!THINKING_LEVELS.includes(args))
        return fail(id, "bad_args", `Thinking level must be one of: ${THINKING_LEVELS.join(", ")}.`);
      const before = pi.getThinkingLevel();
      pi.setThinkingLevel(args); // Pi clamps to what the model supports.
      const level = pi.getThinkingLevel();
      const notice = level === args ? `Thinking: ${level}` : `Thinking: ${level} (${args} is not available for this model)`;
      return handled(id, notice, { thinking: level, requested: args, changed: level !== before });
    },
    async name(id, args) {
      if (!args) return fail(id, "bad_args", "Give a name: /name <name>.");
      pi.setSessionName(args);
      return handled(id, `Name: ${args}`, { name: args });
    },
    async compact(id, args, frame) {
      // Pi's compact aborts a running turn first; that must be the owner's explicit choice.
      if (!ctx.isIdle() && frame.abort !== true)
        return fail(id, "busy", "Compact stops the running turn. Send again with abort to stop and compact.");
      ctx.compact(args ? { customInstructions: args } : {});
      return { ...handled(id, "Compaction started"), evidence: "compaction_started" };
    },
  };
  const handled = (id, notice, effect) => ({ id, ok: true, disposition: "handled", notice, ...(effect ? { effect } : {}) });

  // Resolve the name here, inside the chain: Pi sends an unregistered "/x" on as a plain user message.
  const runCommand = async (id, frame, arrived) => {
    const { name } = frame;
    const args = (frame.args ?? "").trim();
    if (compactingNow()) return fail(id, "busy_compacting", "Pi is compacting; send the command after it ends.");
    if (builtin[name]) return await builtin[name](id, args, frame);
    if (PANE_ONLY.includes(name)) return fail(id, "unsupported_command", `/${name} works only in the Pi pane.`);
    const found = pi.getCommands().find((c) => c.name === name);
    if (!found) return fail(id, "unknown_command", `Pi has no command /${name}; nothing was sent.`);
    const text = `/${name}${args ? ` ${args}` : ""}`;
    if (found.source === "extension") {
      // Pi runs the handler at once and reports neither completion nor failure to extensions.
      pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: true });
      return { id, ok: true, disposition: "dispatched", notice: `Sent ${text} to Pi; its result and errors show in the Pi pane.` };
    }
    // A skill or prompt template expands into a user message: admission as for submit.
    const reply = await submit(id, text, frame.deliverAs ?? "followUp", arrived, true);
    return reply.ok ? { ...reply, disposition: reply.evidence === "started" ? "started" : "queued" } : reply;
  };

  const keyed = new Map(); // idempotency key -> reply promise
  const command = (id, frame, arrived) => {
    const { name, args, key, deliverAs } = frame;
    if (typeof name !== "string" || !NAME.test(name))
      return fail(id, "bad_request", "name must be a command name without the leading slash.");
    if (args !== undefined && typeof args !== "string") return fail(id, "bad_request", "args must be a string.");
    if (key !== undefined && (typeof key !== "string" || !key)) return fail(id, "bad_request", "key must be a nonempty string.");
    if (deliverAs !== undefined && !DELIVER_AS.has(deliverAs))
      return fail(id, "bad_request", 'deliverAs must be "steer" or "followUp".');
    if (key && keyed.has(key)) return keyed.get(key).then((reply) => ({ ...reply, id }));
    const run = chain.then(() => runCommand(id, frame, arrived));
    chain = run.catch(() => {});
    if (key) {
      keyed.set(key, run);
      if (keyed.size > KEEP_KEYS) keyed.delete(keyed.keys().next().value);
    }
    return run;
  };

  const status = () => {
    reconcileQueue();
    settleQueued();
    return {
      ...identity,
      idle: ctx ? ctx.isIdle() : false,
      compacting: compactingNow(),
      held: holds.size > 0,
      pending: { steer: queue.steer.length, followUp: queue.followUp.length },
      submissions: submissions.map(view),
      // Capability: this control serves the commands and command ops.
      commands: 1,
    };
  };

  /** One decoded frame in, one reply out. Never throws. */
  async function handle(frame) {
    const arrived = Date.now();
    if (!frame || typeof frame !== "object" || Array.isArray(frame))
      return fail(null, "bad_request", "Frame must be a JSON object.");
    const { id } = frame;
    if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id)))
      return fail(null, "bad_request", "id must be a string or finite number.");
    if (closed || !ctx) return fail(id, "closed", "Session control is not attached to a live Session.");
    try {
      switch (frame.op) {
        case "status":
          return { id, ok: true, value: status() };
        case "abort":
          return await abort(id);
        case "submit": {
          const { text, deliverAs } = frame;
          if (typeof text !== "string" || !text.trim())
            return fail(id, "bad_request", "text must be a nonempty string.");
          if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES)
            return fail(id, "too_large", `text exceeds ${MAX_TEXT_BYTES} bytes.`);
          if (!DELIVER_AS.has(deliverAs))
            return fail(id, "bad_request", 'deliverAs must be "steer" or "followUp".');
          // One submission at a time keeps queue order equal to arrival order.
          const run = chain.then(() => submit(id, text, deliverAs, arrived));
          chain = run.catch(() => {});
          return await run;
        }
        case "commands":
          return { id, ok: true, value: commands() };
        case "command":
          return await command(id, frame, arrived);
        default:
          return fail(id, "unknown_op", "op must be status, submit, abort, commands, or command.");
      }
    } catch (error) {
      return fail(id, "internal", String(error?.message ?? error));
    }
  }

  return {
    handle,
    status,
    /** Bind to a live Session. */
    attach(context, ids) {
      ctx = context;
      identity = { ...ids };
      closed = false;
      reset();
    },
    /** Session ending: refuse new work and fail outstanding work. */
    detach() {
      closed = true;
      inflight?.closeOut();
      wake();
      reset();
      ctx = undefined;
    },
  };
}
