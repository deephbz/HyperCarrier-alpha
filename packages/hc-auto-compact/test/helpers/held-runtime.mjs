// Real Pi input, user-message, and steering queues with a synthetic model.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function heldRuntime(harness, { busy = false, handle, transform, reject = false } = {}) {
  const sdkPath = process.env.HC_AUTO_COMPACT_TEST_SDK ?? '@earendil-works/pi-coding-agent';
  const sdk = await import(sdkPath);
  const ai = await import('@earendil-works/pi-ai');
  const directory = mkdtempSync(join(tmpdir(), 'auto-compact-held-'));
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, images: { autoResize: false }, cacheWarming: 'off' });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json') });
  const model = modelRuntime.getModels().find(model => model.api === 'anthropic-messages');
  modelRuntime.hasConfiguredAuth = () => !reject;
  modelRuntime.checkAuth = async () => undefined;
  const errors = [], requests = [], events = [];
  let api, release, firstRequest;
  const first = new Promise(resolve => { firstRequest = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  modelRuntime.streamSimple = (_model, context) => {
    requests.push(structuredClone(context.messages));
    const index = requests.length;
    firstRequest();
    const stream = new ai.AssistantMessageEventStream();
    void (async () => {
      if (busy && index === 1) await gate;
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Synthetic response' }],
        api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
    })();
    return stream;
  };
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory,
    settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [pi => {
      api = pi;
      pi.on('input', event => {
        if (event.source !== 'extension') return;
        if (event.source === 'extension' && event.text === handle) return { action: 'handled' };
        if (event.source === 'extension' && event.text === transform) return { action: 'transform', text: 'Transformed text' };
        return harness.handlers.get('input')(event, harness.ctx);
      });
      pi.on('message_start', event => harness.handlers.get('message_start')(event, harness.ctx));
      pi.on('context', event => {
        harness.handlers.get('context')(event, harness.ctx);
        events.push({ type: 'context', held: harness.controller.snapshot().heldCount,
          users: event.messages.filter(message => message.role === 'user').length });
      });
    }] });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory,
    resourceLoader, modelRuntime, model, thinkingLevel: 'off', tools: [],
    settingsManager, sessionManager: sdk.SessionManager.inMemory(directory) });
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
  harness.ctx.isIdle = () => !session.isStreaming;
  session.subscribe(event => {
    events.push({ type: event.type, held: harness.controller.snapshot().heldCount, message: event.message });
  });
  harness.pi.sendMessage = (message, options) => api.sendMessage(message, options);
  harness.pi.sendUserMessage = (content, options) => api.sendUserMessage(content, options);
  const prior = busy ? session.prompt('Existing run') : undefined;
  if (busy) await first;
  return { session, requests, events, errors, release,
    async idle() {
      const deadline = Date.now() + 5000;
      while (!events.some(event => event.type === 'agent_settled') && !errors.length && !(handle === 'First held' && !session.isStreaming)) {
        if (Date.now() > deadline) throw new Error('Synthetic Pi run did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (prior) await prior;
      await session.agent.waitForIdle();
      await new Promise(setImmediate);
    },
    close() { release(); session.dispose(); rmSync(directory, { recursive: true, force: true }); } };
}
