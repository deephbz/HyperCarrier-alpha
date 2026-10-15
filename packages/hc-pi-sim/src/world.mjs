// Verification-only host boundary. Real AgentSession, extensions and provider code remain intact.
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { Entropy, Scheduler, wallNow } from './scheduler.mjs';
import { ScriptedProvider } from './provider.mjs';
import { checkCacheHistory } from './cache-checker.mjs';
import { installHostGuard } from './host-guard.mjs';
import { SIM_API_VERSION } from './version.mjs';

let activeWorld;
const APIs = { anthropic: 'anthropic-messages', 'openai-responses': 'openai-responses', 'openai-completions': 'openai-completions', google: 'google-generative-ai', vertex: 'google-vertex', bedrock: 'bedrock-converse-stream' };
export function defaultPiRoot() {
  try { return dirname(dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))))); }
  catch (cause) { throw new Error('Pi peer @earendil-works/pi-coding-agent is unavailable. Install it or set HC_PI_SIM_PI_ROOT to the @earendil-works directory containing pi-coding-agent and pi-ai.', { cause }); }
}
const jsonCopy = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));

export class SimWorld {
  static async create(options = {}) {
    if (activeWorld) throw new Error('SimWorld is process-global; close the active world or use another process');
    const world = new SimWorld(options); activeWorld = world;
    try { await world.initialize(); return world; }
    catch (error) { await world.close(); throw error; }
  }
  constructor(options) {
    this.options = options; this.seed = options.seed ?? 1; this.family = options.family ?? 'anthropic';
    if (!APIs[this.family]) throw new Error(`unsupported family: ${this.family}`);
    this.history = []; this.restores = []; this.hostViolations = []; this.started = wallNow();
    this.entropy = new Entropy(this.seed, (kind, data) => this.record(kind, data));
    this.scheduler = new Scheduler(this.entropy, (kind, data) => this.record(kind, data), options.epoch, options.hostIOLatency);
    this.provider = new ScriptedProvider({ family: this.family, gateway: options.gateway, replies: options.replies, scheduler: this.scheduler, record: (kind, data) => this.record(kind, data) });
    this.requests = this.provider.requests;
  }
  record(kind, data) {
    this.history.push({ version: 1, sequence: this.history.length, at: this.scheduler?.now ?? 1800000000000, kind, data: jsonCopy(data) });
  }
  async initialize() {
    if (!['memory', 'durable'].includes(this.options.sessionStorage ?? 'memory')) throw new Error('sessionStorage must be memory or durable');
    if (this.options.root !== undefined) {
      this.root = resolve(this.options.root);
      // Atomic ownership: never reuse or remove a caller's existing tree.
      try { await mkdir(this.root); }
      catch (cause) { throw new Error('SimWorld root must be a new isolated directory; existing roots are refused', { cause }); }
    } else this.root = await mkdtemp(join(tmpdir(), 'hc-pi-sim-'));
    this.ownsRoot = true;
    this.cwd = join(this.root, 'workspace'); this.agentDir = join(this.root, '.pi', 'agent');
    this.sessionDir = join(this.root, 'sessions');
    await mkdir(this.cwd, { recursive: true }); await mkdir(this.agentDir, { recursive: true });
    const tempDir = join(this.root, 'tmp');
    await mkdir(tempDir);
    const originalEnv = { ...process.env };
    this.restores.push(() => {
      for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
      Object.assign(process.env, originalEnv);
    });
    // Never inherit provider credentials, real agent roots, terminal bindings, endpoints or proxy routing.
    for (const name of Object.keys(process.env)) if (/(?:TOKEN|API_KEY|SECRET|PASSWORD|PROXY)|^(?:PI_|HERDR_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AWS_|VERTEX_)/i.test(name)) delete process.env[name];
    Object.assign(process.env, { HOME: this.root, XDG_CONFIG_HOME: join(this.root, '.config'), PI_CODING_AGENT_DIR: this.agentDir,
      TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir, JITI_RESPECT_TMPDIR_ENV: '1',
      AWS_BEDROCK_FORCE_HTTP1: '1', AWS_REGION: 'us-east-1' });
    this.piRoot = resolve(this.options.piRoot ?? originalEnv.HC_PI_SIM_PI_ROOT ?? defaultPiRoot());
    const sdkPath = join(this.piRoot, 'pi-coding-agent', 'dist', 'index.js');
    try {
      this.sdk = await import(pathToFileURL(sdkPath).href);
      this.piVersion = JSON.parse(await readFile(join(this.piRoot, 'pi-coding-agent', 'package.json'), 'utf8')).version;
    } catch (cause) {
      throw new Error('Cannot load Pi peer @earendil-works/pi-coding-agent. Check HC_PI_SIM_PI_ROOT: it must contain pi-coding-agent and pi-ai. An explicit root never falls back to another Pi.', { cause });
    }
    const oldFetch = globalThis.fetch;
    globalThis.fetch = this.provider.fetch.bind(this.provider);
    this.restores.push(() => { globalThis.fetch = oldFetch; });
    // Eagerly load provider modules before virtual time. Their algorithms remain unmodified.
    const apiFile = join(this.piRoot, 'pi-ai', 'dist', 'api', `${APIs[this.family]}.js`);
    await import(pathToFileURL(apiFile).href);
    if (this.family === 'bedrock') {
      // AWS uses a Node HTTP handler, not fetch. Intercept its serialized HTTP boundary.
      const require = createRequire(apiFile);
      const { NodeHttpHandler } = require('@smithy/node-http-handler');
      const originalHandle = NodeHttpHandler.prototype.handle;
      const provider = this.provider;
      NodeHttpHandler.prototype.handle = async function(request, options = {}) {
        if (request.hostname !== 'pi-sim.invalid') throw new Error('AWS network escape rejected');
        const response = await provider.respond(`https://${request.hostname}${request.path}`, JSON.parse(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8')), options.abortSignal);
        return { response: { statusCode: response.status, headers: Object.fromEntries(response.headers), body: Readable.from([Buffer.from(await response.arrayBuffer())]) } };
      };
      this.restores.push(() => { NodeHttpHandler.prototype.handle = originalHandle; });
    }
    this.restores.push(installHostGuard(this.root, this.hostViolations));
    this.restores.push(this.scheduler.install());
    const { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } = this.sdk;
    const entry = this.options.providerEntry;
    const providerId = entry?.id ?? this.options.model?.provider ?? 'sim-provider';
    let model = { id: this.family === 'bedrock' ? 'anthropic.claude-sonnet-4-5' : 'sim-model', name: 'Synthetic model', api: APIs[this.family],
      provider: providerId, baseUrl: 'https://pi-sim.invalid', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096,
      ...this.options.model, compat: { ...this.options.model?.compat, ...this.options.compat } };
    const modelsPath = join(this.agentDir, 'models.json');
    if (entry) {
      if (this.options.model || this.options.compat) throw new Error('providerEntry owns model and compat; set them inside its config');
      if (entry.config.apiKey !== 'synthetic-not-a-credential') throw new Error('providerEntry requires the synthetic API key');
      await writeFile(modelsPath, JSON.stringify({ providers: { [entry.id]: entry.config } }));
    }
    this.modelRuntime = await ModelRuntime.create({ authPath: join(this.agentDir, 'auth.json'), modelsPath });
    if (entry) {
      model = this.modelRuntime.getModel(providerId, entry.config.models[0].id);
      if (!model) throw new Error('synthetic provider entry did not load');
      if (model.api !== APIs[this.family]) throw new Error('providerEntry API differs from scripted family');
    } else this.modelRuntime.registerProvider(providerId, { baseUrl: model.baseUrl, api: model.api, apiKey: 'synthetic-not-a-credential', models: [model] });
    if (new URL(model.baseUrl).hostname !== 'pi-sim.invalid') throw new Error('model endpoint must use pi-sim.invalid');
    await this.modelRuntime.setRuntimeApiKey(providerId, 'synthetic-not-a-credential');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', ...this.options.settings });
    this.sessionManager = this.options.sessionStorage === 'durable'
      ? SessionManager.create(this.cwd, this.sessionDir)
      : SessionManager.inMemory(this.cwd);
    const setup = this.options.setup ? await this.scheduler.run(() => this.options.setup({
      root: this.root, cwd: this.cwd, agentDir: this.agentDir, sessionDir: this.sessionDir,
      sdk: this.sdk, modelRuntime: this.modelRuntime, model, sessionManager: this.sessionManager,
      entropy: this.entropy, scheduler: this.scheduler,
    })) : undefined;
    this.resourceLoader = new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [...(this.options.extensionPaths ?? []), ...(setup?.extensionPaths ?? [])],
      extensionFactories: [...(this.options.extensionFactories ?? []), ...(setup?.extensionFactories ?? [])],
      systemPrompt: this.options.systemPrompt ?? 'You are a synthetic verification assistant. Follow the user instructions.' });
    await this.resourceLoader.reload();
    const errors = this.resourceLoader.getExtensions().errors;
    if (errors.length) throw new Error(`extension loading failed: ${JSON.stringify(errors)}`);
    const result = await createAgentSession({ cwd: this.cwd, agentDir: this.agentDir, model, modelRuntime: this.modelRuntime,
      sessionManager: this.sessionManager, settingsManager, resourceLoader: this.resourceLoader, thinkingLevel: 'off',
      noTools: true, ...(this.options.tools ? { tools: this.options.tools } : {}) });
    this.session = result.session;
    this.session.subscribe(event => this.record('session.event', event));
    const ui = new Proxy({ notify: (text, level) => this.record('ui.notify', { text, level }),
      setStatus: (name, value) => this.record('ui.status', { name, value }),
      setWidget: (name, value) => this.record('ui.widget', { name, value }),
      confirm: async () => false, input: async () => undefined, select: async () => undefined,
      theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text },
      ...this.options.uiContext },
    { get: (target, name) => target[name] ?? (() => undefined) });
    await this.scheduler.run(() => this.session.bindExtensions({ mode: this.options.mode ?? 'rpc', uiContext: ui, onError: error => this.record('extension.error', error) }));
    this.captureEntries();
  }
  captureEntries() {
    this.seenEntries ??= new Set();
    for (const entry of this.sessionManager.getEntries()) if (!this.seenEntries.has(entry.id)) {
      this.seenEntries.add(entry.id); this.record('session.entry', entry);
    }
  }
  async run(operation, bounds) {
    const value = await this.scheduler.run(operation, bounds);
    this.captureEntries();
    return value;
  }
  async prompt(text, options) {
    this.record('input', { text, options });
    return this.run(() => this.session.prompt(text, options));
  }
  async advance(ms) { this.record('advance', { ms }); await this.scheduler.advance(ms); this.captureEntries(); }
  report() {
    const wallMs = Math.max(1, wallNow() - this.started), virtualMs = this.scheduler.now - this.scheduler.start;
    return { trace: { version: 1, simulatorVersion: SIM_API_VERSION, seed: this.seed, family: this.family, ...(this.options.gateway ? { gateway: this.options.gateway } : {}), piVersion: this.piVersion,
      history: this.history, requests: this.requests, entries: this.sessionManager.getEntries() },
      cache: checkCacheHistory(this.requests), metrics: { wallMs, virtualMs, speedRatio: virtualMs / wallMs } };
  }
  assertHealthy({ consumeReplies = true } = {}) {
    if (this.hostViolations.length) throw new Error(this.hostViolations.join('; '));
    if (consumeReplies) this.provider.assertConsumed();
    else if (this.provider.failures.length) throw new Error(this.provider.failures.join('; '));
    const errors = this.history.filter(event => event.kind === 'extension.error');
    if (errors.length) throw new Error(`extension errors: ${JSON.stringify(errors)}`);
  }
  async close() {
    if (this.closed) return; this.closed = true;
    try {
      if (this.session) {
        await this.scheduler.run(async () => {
          await this.session.abort();
          await this.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        });
        this.session.dispose();
      }
    }
    finally {
      for (const restore of this.restores.reverse()) restore();
      if (this.ownsRoot) await rm(this.root, { recursive: true, force: true });
      if (activeWorld === this) activeWorld = undefined;
    }
  }
}
