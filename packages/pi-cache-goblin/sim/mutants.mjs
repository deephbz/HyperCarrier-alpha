// Test-only mutants. Real Goblin executes; these faults never ship.
import { createCacheGoblinExtension } from '../src/extension.mjs';

export function oldSystemRuleMutant(options) {
  return pi => createCacheGoblinExtension(options)(new Proxy(pi, {
    get(target, name) {
      if (name !== 'on') return target[name];
      return (eventName, handler) => target.on(eventName, eventName === 'before_provider_request'
        ? (event, ctx) => event.payload.messages?.some(message => message.role === 'system' && message.content?.length)
          ? undefined : handler(event, ctx)
        : handler);
    },
  }));
}

export function markerMutant(kind) {
  return pi => pi.on('before_provider_request', event => {
    const payload = structuredClone(event.payload);
    if (!Array.isArray(payload.messages) || !Array.isArray(payload.system)) return;
    const marked = payload.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.cache_control) : []);
    if (kind === 'wrong-tail-ttl' && marked.length) marked.at(-1).cache_control.ttl = '1h';
    if (kind === 'drop-held-pin' && marked.length > 1) delete marked[0].cache_control;
    return payload;
  });
}
