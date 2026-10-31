import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { SimWorld, checkCacheHistory, normalizeTrace, assertEntriesPreserved } from '@hypercarrier/pi-sim';
import registerAutoCompact from '../src/extension.mjs';

export const families = ['anthropic', 'openai-responses', 'openai-completions', 'google', 'vertex', 'bedrock'];
export const nativeCompat = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
export const magpieCompat = { sendSessionAffinityHeaders: true };
export const longText = 'Synthetic durable progress. '.repeat(100);
export const plans = { summary: 'Synthetic working state', keep: [] };
export const hasPrefixBreak = report => report.cache.violations.some(v => v.property === 'stable-cache-prefix');
export const entriesOf = (world, type) => world.sessionManager.getEntries().filter(entry => entry.type === type);
export const userTexts = world => entriesOf(world, 'message').filter(entry => entry.message.role === 'user').map(entry => typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
export const notices = world => world.history.filter(event => event.kind === 'ui.notify').map(event => event.data.text);

export async function createWorld({ auto = {}, mutant, ...options } = {}) {
  const world = await SimWorld.create({ seed: 37, ...options, extensionFactories: [pi => {
    // A normal pre-existing tool makes native addition support observable.
    pi.registerTool({ name: 'anchor', label: 'Anchor', description: 'Synthetic read-only anchor',
      parameters: Type.Object({}), async execute() { return { content: [{ type: 'text', text: 'Anchor evidence' }] }; } });
    const mutation = mutant?.(pi);
    registerAutoCompact(mutation?.api ?? pi);
    mutation?.after?.();
  }] });
  try {
    writeFileSync(join(world.agentDir, 'settings.json'), JSON.stringify({ auto_compact: auto }));
    // A real startup hook reads the isolated settings file before the first request.
    await world.run(() => world.session.extensionRunner.emit({ type: 'session_start' }));
    return world;
  } catch (error) { await world.close(); throw error; }
}

export async function until(world, predicate, label = 'settlement') {
  try { await world.run(async () => {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Missing ${label}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }); } catch (error) {
    error.trace = normalizeTrace(world.report().trace, world.root);
    throw error;
  }
}
export async function command(world, args) { await world.prompt(`/auto-compact ${args}`); }
export async function reportWorld(world) {
  world.assertHealthy();
  const report = world.report();
  return { ...report, trace: normalizeTrace(report.trace, world.root) };
}

export async function toolTransitions({ family = 'anthropic', compat, writer = 'ready', ...options } = {}) {
  const world = await createWorld({ family, compat, ...options,
    replies: [{ text: 'First' }, { text: 'Waiting' }, { text: 'After' }] });
  try {
    await world.prompt('First request');
    const before = structuredClone(world.sessionManager.getEntries());
    if (writer === 'ready') {
      await command(world, 'run');
      await until(world, () => notices(world).some(text => text.includes('Compaction failed')), 'small-session native rejection');
    } else {
      await command(world, 'method summary');
      await world.prompt('Second request');
      await command(world, 'method native');
    }
    await world.prompt('After transition');
    assertEntriesPreserved(before, world.sessionManager.getEntries());
    return reportWorld(world);
  } finally { await world.close(); }
}

export async function foreground({ method = 'summary', held = false, ...options } = {}) {
  const world = await createWorld({ auto: { method, preservation: 'none' }, settings: { compaction: { enabled: false, keepRecentTokens: 32 } }, compat: nativeCompat, ...options,
    replies: [{ text: longText }, { toolCalls: [{ name: 'compaction_plan', arguments: plans }], delayMs: held ? 100 : 0 },
      { text: 'Resumed' }] });
  try {
    await world.prompt('Original human goal');
    const before = structuredClone(world.sessionManager.getEntries());
    await command(world, 'run');
    if (held) {
      world.scheduler.schedule(() => { void world.session.prompt('Held first', { source: 'interactive', streamingBehavior: 'steer' }); }, 10, 'held-first');
      world.scheduler.schedule(() => { void world.session.prompt('Held second', { source: 'interactive', streamingBehavior: 'steer' }); }, 20, 'held-second');
    }
    await until(world, () => world.requests.length === 3 && !world.session.isStreaming, 'foreground pickup');
    assertEntriesPreserved(before, world.sessionManager.getEntries());
    return { ...(await reportWorld(world)), users: userTexts(world) };
  } finally { await world.close(); }
}

export async function nativeCompaction({ fail = false, ...options } = {}) {
  const world = await createWorld({ auto: { method: 'native', preservation: 'none' }, settings: { compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 100 } },
    compat: nativeCompat, ...options, replies: [{ text: longText }, { text: 'Recent response' },
      ...(fail ? [{ status: 400, error: 'Synthetic summary rejected' }] : []), { text: 'Native state summary' }, { text: 'Resumed' }] });
  try {
    await world.prompt('First native goal'); await world.prompt('Recent native goal');
    const before = structuredClone(world.sessionManager.getEntries());
    await command(world, 'run');
    if (fail) {
      await until(world, () => notices(world).some(text => text.includes('Compaction failed')), 'native failure');
      if (entriesOf(world, 'compaction').length) throw new Error('Failed compaction installed a summary');
      await command(world, 'run');
    }
    await until(world, () => entriesOf(world, 'compaction').length === 1 && !world.session.isStreaming && world.requests.length === (fail ? 5 : 4), 'native pickup');
    assertEntriesPreserved(before, world.sessionManager.getEntries());
    return reportWorld(world);
  } finally { await world.close(); }
}

export async function threshold({ threshold = 90, budget = 10000, input = 8000, delayMs = 0, ...options } = {}) {
  const crossed = input + 1 >= budget * threshold / 100;
  const world = await createWorld({ auto: { method: 'native', threshold, budget_tokens: budget }, compat: nativeCompat, ...options,
    replies: [{ text: 'Usage evidence', usage: { input, output: 1 }, delayMs }, ...(crossed ? [{ text: 'Handoff evidence' }] : [])] });
  try {
    await world.prompt('Threshold goal');
    if (crossed) await until(world, () => notices(world).some(text => text.includes('Compaction failed')), 'threshold handoff');
    return reportWorld(world);
  } finally { await world.close(); }
}

export async function background({ family = 'anthropic', fail = false, ...options } = {}) {
  const world = await createWorld({ family, auto: { method: 'summary', execution: 'background', preservation: 'none' }, settings: { compaction: { enabled: false, keepRecentTokens: 32 } }, compat: nativeCompat, ...options,
    replies: [{ text: longText }, { text: 'Foreground continues', delayMs: 100 },
      fail ? { status: 400, error: 'Synthetic fork rejected' } : { text: JSON.stringify(plans), delayMs: 20 },
      ...(fail ? [] : [{ text: 'Resumed' }])] });
  try {
    await world.prompt('Original background goal');
    const before = structuredClone(world.sessionManager.getEntries());
    await command(world, 'run');
    await world.prompt('Work after fork capture');
    await until(world, () => fail ? notices(world).some(text => text.includes('failed')) : entriesOf(world, 'compaction').length === 1 && world.requests.length === 4 && !world.session.isStreaming, 'background result');
    assertEntriesPreserved(before, world.sessionManager.getEntries());
    return reportWorld(world);
  } finally { await world.close(); }
}

export async function wrongTool({ method = 'summary', ...options } = {}) {
  const native = method === 'native';
  const wrong = native ? 'compaction_plan' : 'auto_compact_ready';
  const right = native ? 'auto_compact_ready' : 'compaction_plan';
  const world = await createWorld({ ...options,
    auto: { method, execution: 'foreground', preservation: native ? 'artifact-handoff' : 'none' },
    settings: { compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 32 } },
    replies: [{ text: longText }, ...(native ? [{ text: 'Recent native context' }] : []),
      { toolCalls: [{ name: wrong, arguments: native ? plans : {} }] },
      { toolCalls: [{ name: right, arguments: native ? {} : plans }], delayMs: 100 },
      ...(native ? [{ text: 'Native state after corrected readiness' }, { text: 'Native turn checkpoint' }] : []), { text: 'Resumed after correction' }] });
  try {
    await world.prompt('Original correction goal');
    if (native) await world.prompt('Recent correction goal');
    await command(world, 'run');
    const results = () => world.history.filter(event => event.kind === 'session.event' && event.data.type === 'tool_execution_end');
    await until(world, () => results().some(event => event.data.toolName === wrong), 'wrong-tool refusal');
    await command(world, 'status');
    const pendingStatus = notices(world).at(-1);
    const compactionsAfterRefusal = entriesOf(world, 'compaction').length;
    await until(world, () => entriesOf(world, 'compaction').length === 1 && !world.session.isStreaming && world.requests.length === (native ? 7 : 4), 'corrected compaction pickup');
    await command(world, 'status');
    const report = await reportWorld(world);
    // Summary and pickup replace the conversation by design. Check the live
    // handoff prefix through the request that delivers the correct tool call.
    const handoffRequests = report.trace.requests.slice(0, native ? 4 : 3);
    return { ...report, wrong, right, pendingStatus, compactionsAfterRefusal,
      finalStatus: notices(world).at(-1), results: results().map(event => event.data),
      handoffCache: checkCacheHistory(handoffRequests), handoffRequests };
  } finally { await world.close(); }
}
