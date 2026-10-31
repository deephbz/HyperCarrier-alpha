import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { createSlotStore, SLOT_EVENT, COMPOSER_EVENT } from "./contract.mjs";
import { renderFooter } from "./visual-language.mjs";

// Match Pi FooterComponent: cost spans all entries; cache hit uses the latest assistant prompt.
export function sessionStats(entries) {
  let cost = 0, cacheHit;
  for (const entry of entries) {
    let usage;
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
    else if (entry.type === "message" && ["assistant", "toolResult"].includes(entry.message.role)) {
      usage = entry.message.usage;
      if (entry.message.role === "assistant" && usage) {
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        cacheHit = prompt > 0 ? 100 * usage.cacheRead / prompt : undefined;
      }
    }
    cost += usage?.cost?.total ?? 0;
  }
  return { cost, cacheHit };
}
export function displayCwd(cwd, home = homedir()) {
  const rel = relative(home, cwd);
  return rel === "" ? "~" : rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? `~${sep}${rel}` : cwd;
}
// ctx.getContextUsage() and Pi 1.4.0's getSessionName() scan the whole Session,
// so callers that render per frame pass cached values (see the footer render below).
export function collectNative(ctx, pi, footerData, env = process.env, usage = ctx.getContextUsage(),
  session = ctx.sessionManager.getSessionName()) {
  const manager = ctx.sessionManager;
  return {
    cwd: displayCwd(manager.getCwd()), branch: footerData.getGitBranch(),
    session, multiplexer: Boolean(env.TMUX || env.HERDR_ENV),
    model: ctx.model ? { ...ctx.model, thinking: pi.getThinkingLevel() } : undefined,
    context: { used: usage?.tokens ?? null, limit: usage?.contextWindow ?? ctx.model?.contextWindow ?? 1 },
    statuses: footerData.getExtensionStatuses(),
  };
}
export function createComposer(pi, { aliases = {}, env = process.env } = {}) {
  let context, requestRender = () => {}, tier = "auto", present = false, announcing = false;
  const seenProducers = new Set();
  const store = createSlotStore({ warn: (message) => context?.ui.notify(message, "warning") });
  let cachedStats, cachedUsage, cachedName, cachedKey, staleTimer, installFooter = () => {};
  const scheduleStaleness = () => {
    clearTimeout(staleTimer);
    if (!present) return;
    const now = Date.now();
    const deadlines = [...store.slots.values()]
      .filter((slot) => slot.staleAfterMs !== undefined)
      .map((slot) => slot.asOf + slot.staleAfterMs + 1)
      .filter((deadline) => deadline > now);
    if (deadlines.length) {
      staleTimer = setTimeout(() => { requestRender(); scheduleStaleness(); },
        Math.min(2147483647, Math.min(...deadlines) - now));
      staleTimer.unref?.();
    }
  };
  const announce = (next) => {
    present = next;
    announcing = true;
    try { pi.events.emit(COMPOSER_EVENT, { v: 1, present: next, surface: "tui-footer" }); }
    finally { announcing = false; }
  };
  const unsubscribe = pi.events.on(SLOT_EVENT, (slot) => {
    if (store.accept(slot)) {
      const first = !seenProducers.has(slot.producer);
      seenProducers.add(slot.producer);
      if (present && first && !announcing) { announce(true); installFooter(); }
      scheduleStaleness();
      requestRender();
    }
  });
  return {
    store,
    start(ctx, modelAliases = aliases) {
      context = ctx;
      aliases = modelAliases;
      cachedKey = undefined;
      clearTimeout(staleTimer);
      store.clear();
      seenProducers.clear();
      if (ctx.mode !== "tui") return;
      installFooter = () => ctx.ui.setFooter((tui, theme, footerData) => {
        requestRender = () => tui.requestRender();
        const unbranch = footerData.onBranchChange(requestRender);
        return {
          invalidate() { cachedKey = undefined; },
          dispose() {
            unbranch();
            requestRender = () => {};
          },
          render(width) {
            // Cost, context usage, and the Session name all scan the whole Session,
            // and the footer renders on every frame. Match Pi FooterComponent's cache
            // key: the results change only with the Session, leaf, entry count, or
            // model. A rename appends a session_info entry, so it changes the count.
            const manager = context.sessionManager;
            const key = [manager.getSessionId(), manager.getLeafId(), manager.getEntryCount(), context.model];
            if (!cachedKey || key.some((value, i) => value !== cachedKey[i])) {
              cachedStats = sessionStats(manager.getEntries());
              cachedUsage = context.getContextUsage();
              cachedName = manager.getSessionName();
              cachedKey = key;
            }
            return renderFooter({ ...collectNative(context, pi, footerData, env, cachedUsage, cachedName),
              aliases, slots: store.slots, ...cachedStats,
            }, width, { tier, theme });
          },
        };
      });
      announce(true);
      installFooter();
    },
    refresh(ctx) { context = ctx; requestRender(); },
    setTier(next) { tier = next; requestRender(); },
    shutdown() {
      if (present) {
        context?.ui.setFooter(undefined);
        announce(false);
      }
      clearTimeout(staleTimer);
      unsubscribe();
      store.clear();
      requestRender = () => {};
    },
  };
}
