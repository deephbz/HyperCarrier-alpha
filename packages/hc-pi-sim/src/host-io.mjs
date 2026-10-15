// Host-latency injection tests settlement. It is not a filesystem timing model.
import fsp from 'node:fs/promises';
import timers from 'node:timers';

const hostTimeout = timers.setTimeout;

export const trackedHandleMethods = Object.freeze(['read', 'write', 'writeFile', 'sync', 'close', 'stat']);
const validOperations = new Set([
  ...Object.entries(fsp).filter(([name, value]) => typeof value === 'function' && !['watch', 'glob'].includes(name)).map(([name]) => name),
  ...trackedHandleMethods.map(name => `FileHandle.${name}`),
]);
const validDelay = ms => Number.isFinite(ms) && ms >= 0 && ms <= 2147483647;

export function delayHostIO({ operations, delayMs, path } = {}) {
  if (!Array.isArray(operations) || !operations.length || operations.some(name => !validOperations.has(name))) {
    throw new TypeError('delayHostIO operations must name tracked fs.promises functions or FileHandle methods');
  }
  if (!validDelay(delayMs)) throw new RangeError('delayHostIO delayMs must be finite and between 0 and 2147483647');
  if (path !== undefined && typeof path !== 'function') throw new TypeError('delayHostIO path must be a predicate');
  const selected = new Set(operations);
  return event => selected.has(event.operation) && (!path || path(event.path)) ? delayMs : 0;
}

export function hostIODelay(policy, event) {
  const ms = policy?.(event) ?? 0;
  if (!validDelay(ms)) throw new RangeError('hostIOLatency must return finite milliseconds between 0 and 2147483647');
  return ms;
}

export function delayCompletion(operation, ms) {
  if (!ms) return operation;
  const wait = () => new Promise(resolve => hostTimeout(resolve, ms));
  return Promise.resolve(operation).then(
    async value => { await wait(); return value; },
    async error => { await wait(); throw error; },
  );
}
