// One entropy tape and queue own simulated boundary choices. No extension logic lives here.
import crypto from 'node:crypto';
import timers from 'node:timers';
import timerPromises from 'node:timers/promises';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { trackedHandleMethods, hostIODelay, delayCompletion } from './host-io.mjs';

const hostImmediate = timers.setImmediate;
const hostNow = Date.now.bind(Date);
export const hostTurn = () => new Promise(resolve => hostImmediate(resolve));
export const wallNow = hostNow;

export class Entropy {
  constructor(seed = 1, record = () => {}) {
    if (!Number.isInteger(seed)) throw new TypeError('seed must be an integer');
    this.state = seed >>> 0;
    this.record = record;
  }
  choose(bound, label = 'choice') {
    if (!Number.isSafeInteger(bound) || bound < 1) throw new RangeError('invalid entropy bound');
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let x = this.state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    const value = ((x ^ (x >>> 14)) >>> 0) % bound;
    this.record('entropy', { label, bound, value });
    return value;
  }
  bytes(length) {
    return Uint8Array.from({ length }, () => this.choose(256, 'byte'));
  }
  uuid() {
    const bytes = this.bytes(16);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Buffer.from(bytes).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

export class Scheduler {
  constructor(entropy, record = () => {}, epoch = 1800000000000, hostIOLatency) {
    if (hostIOLatency !== undefined && typeof hostIOLatency !== 'function') throw new TypeError('hostIOLatency must be a latency policy');
    this.hostIOLatency = hostIOLatency;
    this.entropy = entropy;
    this.record = record;
    this.now = epoch;
    this.start = epoch;
    this.queue = new Map();
    this.nextId = 0;
    this.pendingIO = new Set();
  }
  schedule(callback, delay = 0, label = 'timer', interval = 0) {
    if (!Number.isFinite(Number(delay)) || Number(delay) < 0) delay = 0;
    const id = ++this.nextId;
    const item = { id, at: this.now + Number(delay), callback, label, interval };
    this.queue.set(id, item);
    return { id, ref() { return this; }, unref() { return this; }, hasRef: () => false,
      refresh: () => { item.at = this.now + Number(delay); this.queue.set(id, item); },
      [Symbol.toPrimitive]: () => id };
  }
  cancel(handle) { this.queue.delete(Number(handle)); }
  async step(until = Infinity) {
    const next = Math.min(...[...this.queue.values()].map(item => item.at));
    if (!Number.isFinite(next) || next > until) return false;
    this.now = Math.max(this.now, next);
    const ready = [...this.queue.values()].filter(item => item.at <= this.now);
    const chosen = ready[this.entropy.choose(ready.length, 'schedule')];
    this.queue.delete(chosen.id);
    this.record('schedule', { id: chosen.id, label: chosen.label, enabled: ready.map(x => x.id) });
    if (chosen.interval) { chosen.at = this.now + chosen.interval; this.queue.set(chosen.id, chosen); }
    chosen.callback();
    for (let i = 0; i < 32; i++) await Promise.resolve();
    return true;
  }
  async drainHostWork(started, wallTimeoutMs) {
    // Host completion latency must not race a virtual timer or escape settlement.
    do {
      for (let i = 0; i < 16; i++) await hostTurn();
      if (wallNow() - started > wallTimeoutMs) throw new Error('world stalled: wall-time safety bound exceeded');
    } while (this.pendingIO.size);
  }
  async advance(ms, { wallTimeoutMs = 15000, maxSteps = 10000 } = {}) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance requires nonnegative milliseconds');
    const target = this.now + ms, started = wallNow();
    let steps = 0;
    while (true) {
      await this.drainHostWork(started, wallTimeoutMs);
      if (!await this.step(target)) break;
      if (++steps > maxSteps) throw new Error('scheduler step budget exceeded');
    }
    this.now = target;
  }
  async run(operation, { wallTimeoutMs = 15000, maxSteps = 10000 } = {}) {
    let done = false, value, error;
    Promise.resolve().then(operation).then(v => { value = v; done = true; }, e => { error = e; done = true; });
    const started = wallNow();
    let steps = 0;
    while (!done || this.pendingIO.size) {
      await this.drainHostWork(started, wallTimeoutMs);
      if (done) break;
      if (await this.step()) if (++steps > maxSteps) throw new Error('scheduler step budget exceeded');
    }
    if (error) throw error;
    return value;
  }
  install() {
    const scheduler = this, entropy = this.entropy;
    const originals = { Date, random: Math.random, uuid: crypto.randomUUID,
      getRandomValues: crypto.webcrypto.getRandomValues, randomBytes: crypto.randomBytes };
    const performanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
    const oldPromiseTimeout = timerPromises.setTimeout;
    const ioRestores = [], handleRestores = [];
    const track = operation => {
      const pending = Promise.resolve(operation);
      scheduler.pendingIO.add(pending);
      pending.then(() => scheduler.pendingIO.delete(pending), () => scheduler.pendingIO.delete(pending));
      return pending;
    };
    const latency = (operation, path) => {
      const delayMs = hostIODelay(scheduler.hostIOLatency, { operation, path });
      if (delayMs) scheduler.record('host.io.delay', { operation, path, delayMs });
      return delayMs;
    };
    const trackHandle = (handle, path) => {
      for (const name of trackedHandleMethods) {
        const descriptor = Object.getOwnPropertyDescriptor(handle, name), original = handle[name];
        handle[name] = function(...args) {
          const delayMs = latency(`FileHandle.${name}`, path);
          return track(delayCompletion(Reflect.apply(original, this, args), delayMs));
        };
        handleRestores.push(() => {
          if (descriptor) Object.defineProperty(handle, name, descriptor);
          else delete handle[name];
        });
      }
      return handle;
    };
    const hostMkdir = fsp.mkdir;
    const makeTemp = async (prefix, options) => {
      if (typeof prefix !== 'string') throw new TypeError('simulated mkdtemp requires a string prefix');
      const encoding = typeof options === 'string' ? options : options?.encoding ?? 'utf8';
      if (encoding !== 'buffer' && !Buffer.isEncoding(encoding)) throw new TypeError('invalid mkdtemp encoding');
      const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      for (let attempt = 0; attempt < 100; attempt++) {
        const path = prefix + Array.from({ length: 6 }, () => alphabet[entropy.choose(alphabet.length, 'mkdtemp')]).join('');
        try {
          // Capture the guarded mkdir; deterministic naming must not bypass isolation.
          await hostMkdir(path, { mode: 0o700 });
          const bytes = Buffer.from(path);
          return encoding === 'buffer' ? bytes : bytes.toString(encoding);
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      throw new Error('simulated mkdtemp collision budget exceeded');
    };
    // Enumerate the host API: a newly used promise function must not escape settlement.
    for (const [name, original] of Object.entries(fsp)) {
      if (typeof original !== 'function') continue;
      fsp[name] = (...args) => {
        // These return async iterators, whose open-ended lifetime is not modeled.
        if (name === 'watch' || name === 'glob') throw new Error(`unmodeled filesystem iterator: ${name}`);
        const delayMs = latency(name, args[0]);
        const operation = name === 'mkdtemp' ? makeTemp(...args) : Reflect.apply(original, fsp, args);
        const result = name === 'open' ? Promise.resolve(operation).then(handle => trackHandle(handle, args[0])) : operation;
        return track(delayCompletion(result, delayMs));
      };
      ioRestores.push(() => { fsp[name] = original; });
    }
    const timerNames = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'];
    const oldTimers = Object.fromEntries(timerNames.map(name => [name, { global: globalThis[name], node: timers[name] }]));
    class VirtualDate extends originals.Date {
      constructor(...args) { super(...(args.length ? args : [scheduler.now])); }
      static now() { return scheduler.now; }
    }
    globalThis.Date = VirtualDate;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => scheduler.now - scheduler.start });
    timerPromises.setTimeout = (ms, value, options = {}) => new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return; }
      const abort = () => { scheduler.cancel(handle); reject(options.signal.reason); };
      const handle = scheduler.schedule(() => { options.signal?.removeEventListener('abort', abort); resolve(value); }, ms, 'timers/promises');
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    Math.random = () => entropy.choose(0x100000000, 'Math.random') / 0x100000000;
    crypto.randomUUID = () => entropy.uuid();
    crypto.randomBytes = (size, callback) => {
      const bytes = Buffer.from(entropy.bytes(size));
      if (callback) { scheduler.schedule(() => callback(null, bytes), 0, 'randomBytes'); return; }
      return bytes;
    };
    crypto.webcrypto.getRandomValues = array => {
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(entropy.bytes(array.byteLength));
      return array;
    };
    const replacements = {
      setTimeout: (fn, ms, ...args) => scheduler.schedule(() => fn(...args), ms),
      clearTimeout: handle => scheduler.cancel(handle),
      setInterval: (fn, ms, ...args) => scheduler.schedule(() => fn(...args), Math.max(1, ms || 1), 'interval', Math.max(1, ms || 1)),
      clearInterval: handle => scheduler.cancel(handle),
      setImmediate: (fn, ...args) => scheduler.schedule(() => fn(...args), 0, 'immediate'),
      clearImmediate: handle => scheduler.cancel(handle),
    };
    for (const name of timerNames) globalThis[name] = timers[name] = replacements[name];
    syncBuiltinESMExports();
    return () => {
      for (const restore of handleRestores.reverse()) restore();
      for (const restore of ioRestores.reverse()) restore();
      globalThis.Date = originals.Date;
      if (performanceNow) Object.defineProperty(performance, 'now', performanceNow);
      else delete performance.now;
      timerPromises.setTimeout = oldPromiseTimeout;
      Math.random = originals.random;
      crypto.randomUUID = originals.uuid;
      crypto.randomBytes = originals.randomBytes;
      crypto.webcrypto.getRandomValues = originals.getRandomValues;
      for (const name of timerNames) { globalThis[name] = oldTimers[name].global; timers[name] = oldTimers[name].node; }
      syncBuiltinESMExports();
    };
  }
}
