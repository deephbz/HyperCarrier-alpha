export const SLOT_EVENT = "hc.hud.slot";
export const COMPOSER_EVENT = "hc.hud.composer";
export const OWNERS = Object.freeze({
  "context.budget": "hc-auto-compact",
  "team.member": "pi-team-bright",
});

const number = (n) => Number.isFinite(n) && n >= 0;
const text = (s) => typeof s === "string";
function hasControls(value) {
  if (typeof value === "string") return /[\x00-\x1f\x7f-\x9f]/.test(value);
  if (value && typeof value === "object") return Object.values(value).some(hasControls);
  return false;
}
export function validSlot(slot) {
  if (!slot || slot.v !== 1 || !/^[\w-]+(?:\.[\w-]+)+$/.test(slot.key) ||
      !text(slot.producer) || !slot.producer || !number(slot.asOf) ||
      (slot.staleAfterMs !== undefined && !number(slot.staleAfterMs)) ||
      hasControls(slot)) return false;
  const v = slot.value;
  if (v === null) return true;
  if (!v || typeof v !== "object") return false;
  if (slot.key === "context.budget" && v.kind !== "ratio") return false;
  if (slot.key === "team.member" && v.kind !== "identity") return false;
  switch (v.kind) {
    case "ratio": return number(v.used) && number(v.limit) && v.limit > 0 && text(v.unit) &&
      (v.capacity === undefined || number(v.capacity)) &&
      (v.threshold === undefined || number(v.threshold)) &&
      (v.mode === undefined || ["auto", "off", "disarmed"].includes(v.mode)) &&
      (v.phase === undefined || ["handoff", "compacting"].includes(v.phase)) &&
      (v.held === undefined || number(v.held));
    case "identity": return text(v.team) && text(v.role);
    case "label": return text(v.text);
    case "count": return number(v.n) && (v.unread === undefined || number(v.unread));
    case "status": return ["ok", "warn", "error"].includes(v.level) && text(v.text);
    default: return false;
  }
}

export function createSlotStore({ warn = () => {} } = {}) {
  const slots = new Map(), owners = new Map(), timestamps = new Map(), warned = new Set();
  return {
    slots,
    accept(slot) {
      if (!validSlot(slot)) return false;
      const owner = owners.get(slot.key);
      if (owner && owner !== slot.producer) {
        if (!warned.has(slot.key)) { warned.add(slot.key); warn(`HUD slot ${slot.key} already has a producer`); }
        return false;
      }
      if ((timestamps.get(slot.key) ?? -Infinity) > slot.asOf) return false;
      owners.set(slot.key, slot.producer);
      timestamps.set(slot.key, slot.asOf);
      if (slot.value === null) slots.delete(slot.key);
      else slots.set(slot.key, structuredClone(slot));
      return true;
    },
    clear() { slots.clear(); owners.clear(); timestamps.clear(); warned.clear(); },
    dump(now = Date.now()) {
      return [...slots.values()].map((slot) => ({ ...slot, stale: isStale(slot, now) }));
    },
  };
}
export function isStale(slot, now) {
  return slot.staleAfterMs !== undefined && now - slot.asOf > slot.staleAfterMs;
}
