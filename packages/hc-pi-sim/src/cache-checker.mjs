import { gatewayEvidence } from './profiles.mjs';

// Independent structural cache oracle. It never imports Pi or extension reducers.
// Block counts are structural measurements. They do not predict token counts or billing.
export const CACHE_RULES = Object.freeze({
  anthropic: { evidence: 'documented', url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
    rules: ['tools -> system -> messages', 'exact prefix through breakpoint', 'four explicit breakpoints', '20-block lookback', '5m/1h TTL refreshed on hit'] },
  bedrock: { evidence: 'documented', url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html',
    rules: ['cachePoint marks a reusable prefix', 'TTL refreshed on hit', 'model-specific minimums and checkpoint limits require a model profile'] },
  'openai-responses': { evidence: 'advisory', url: 'https://platform.openai.com/docs/guides/prompt-caching',
    rules: ['exact prefix required', 'prompt_cache_key contributes to routing', 'automatic hit/retention and hidden serialization not guaranteed'] },
  'openai-completions': { evidence: 'advisory', url: 'https://platform.openai.com/docs/guides/prompt-caching',
    rules: ['exact prefix required', 'prompt_cache_key contributes to routing', 'automatic hit/retention and hidden serialization not guaranteed'] },
  google: { evidence: 'advisory', url: 'https://ai.google.dev/gemini-api/docs/caching',
    rules: ['shared prefix improves implicit caching', 'implicit hits not guaranteed', 'explicit cachedContent resource lifetime requires external evidence'] },
  vertex: { evidence: 'advisory', url: 'https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview',
    rules: ['implicit and explicit caches are distinct', 'hidden request serialization and retention not modeled'] },
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const key = value => JSON.stringify(stable(value));
// Only protocol-owned block fields are markers. Same-named fields in tool data/schema are content.
const withoutCacheControl = block => block && typeof block === 'object' && !Array.isArray(block)
  ? Object.fromEntries(Object.entries(block).filter(([name]) => name !== 'cache_control')) : block;
const openaiMessage = message => ({ ...message,
  ...(Array.isArray(message.content) ? { content: message.content.map(withoutCacheControl) } : {}),
  ...(Array.isArray(message.tools) ? { tools: message.tools.map(withoutCacheControl) } : {}),
});
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const ttl = marker => marker?.ttl === '1h' ? 3600000 : 300000;
export function cacheShape(family, body, { gateway } = {}) {
  if (gateway !== undefined) gatewayEvidence(family, gateway, body);
  const blocks = [], markers = [], issues = [], lookbackPositions = [];
  let position = 0, previousGroup;
  const add = (value, path, marker, group) => {
    if (!group || group !== previousGroup) position++;
    previousGroup = group;
    lookbackPositions.push(position);
    blocks.push(key(value));
    if (marker) {
      if (marker.ttl !== undefined && !['5m', '1h'].includes(marker.ttl)) issues.push({ property: 'valid-ttl', path });
      markers.push({ end: blocks.length, ttlMs: ttl(marker), path });
    }
  };
  if (family === 'anthropic' || family === 'bedrock-anthropic') {
    // https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
    // Deferred tool definitions do not enter the initial tool prefix.
    for (const [i, tool] of list(body.tools).entries()) if (!tool.defer_loading) add({ tool: withoutCacheControl(tool) }, `tools[${i}]`, tool.cache_control);
    for (const [i, block] of list(body.system).entries()) add({ system: withoutCacheControl(block) }, `system[${i}]`, block.cache_control);
    for (const [i, message] of list(body.messages).entries()) for (const [j, block] of list(message.content).entries()) {
      // Claude API lookback counts a consecutive tool_use or tool_result run as one position.
      // https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-automatic-prefix-checking-works
      // Keep every block for exact matching. This grouping is not asserted for Bedrock.
      const group = family === 'anthropic' && ['tool_use', 'tool_result'].includes(block.type) ? `${message.role}:${block.type}` : undefined;
      add({ role: message.role, block: withoutCacheControl(block) }, `messages[${i}].content[${j}]`, block.cache_control, group);
    }
    if (body.cache_control && blocks.length) markers.push({ end: blocks.length, ttlMs: ttl(body.cache_control), path: 'cache_control' });
    if (markers.length > 4) issues.push({ property: 'marker-limit', count: markers.length, limit: 4 });
    for (let i = 1; i < markers.length; i++) if (markers[i].ttlMs > markers[i - 1].ttlMs) issues.push({ property: 'long-ttl-before-short', path: markers[i].path });
  } else if (family === 'bedrock') {
    // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_CachePointBlock.html
    const append = (values, path, role) => list(values).forEach((block, i) => {
      if (block.cachePoint) {
        if (!blocks.length) issues.push({ property: 'empty-checkpoint', path });
        markers.push({ end: blocks.length, ttlMs: ttl(block.cachePoint), path: `${path}[${i}]` });
      } else add({ role, block }, `${path}[${i}]`);
    });
    append(body.toolConfig?.tools, 'toolConfig.tools', 'tool');
    append(body.system, 'system', 'system');
    list(body.messages).forEach((message, i) => append(message.content, `messages[${i}].content`, message.role));
  } else if (gateway === 'anthropic') {
    // Anthropic documents tools -> system -> messages (CACHE_RULES.anthropic.url).
    // This is a client structural projection, not an implementation of magpie translation.
    // HC verify-pi-magpie/features/client-cache-marks.md: the opt-in has no effect on Chat.
    for (const [i, tool] of list(body.tools).entries()) add({ tool: withoutCacheControl(tool) }, `tools[${i}]`);
    let conversation = false;
    list(body.messages).forEach((message, i) => {
      if (!['system', 'developer'].includes(message.role)) conversation = true;
      add(conversation ? openaiMessage(message) : { system: message.content }, `messages[${i}]`);
    });
  } else if (family === 'openai-responses' || family === 'openai-completions') {
    // Exact prefix is documented. Ordering of separately serialized tools/instructions is advisory.
    if (body.tools?.length) add({ tools: body.tools.map(withoutCacheControl) }, 'tools');
    if (body.instructions) add({ instructions: body.instructions }, 'instructions');
    list(body.input ?? body.messages).forEach((message, i) => add(typeof message === 'object' ? openaiMessage(message) : message, `input[${i}]`));
  } else if (family === 'google' || family === 'vertex') {
    // Google does not document a full canonical serialization order. Structural estimate only.
    if (body.cachedContent) add({ cachedContent: body.cachedContent }, 'cachedContent');
    if (body.tools?.length) add({ tools: body.tools }, 'tools');
    if (body.systemInstruction) add({ system: body.systemInstruction }, 'systemInstruction');
    list(body.contents).forEach((message, i) => list(message.parts).forEach((part, j) => add({ role: message.role, part }, `contents[${i}].parts[${j}]`)));
  } else throw new Error(`unknown cache family: ${family}`);
  return { blocks, markers, issues, lookbackPositions };
}
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
function modelResource(family, url) {
  // Bedrock modelId and Google/Vertex model resources are URL parameters, not JSON fields.
  // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
  // https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
  // https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/projects.locations.publishers.models/streamGenerateContent
  if (family === 'bedrock' || family === 'bedrock-anthropic') return url.pathname.match(/^(.*\/model\/[^/]+)/)?.[1] ?? url.pathname;
  if (family === 'google' || family === 'vertex') return url.pathname.match(/^(.*\/models\/[^/:]+)/)?.[1] ?? url.pathname;
  return '';
}

export function checkCacheHistory(requests, { implicitTtlMs = 300000 } = {}) {
  const caches = new Map(), priorRequests = new Map(), assessments = [], violations = [];
  for (const request of requests) {
    const { family, body, at = 0 } = request;
    const completedSuccess = request.outcome === 'completed' && Number.isFinite(request.completedAt) && request.status >= 200 && request.status < 300;
    const gateway = gatewayEvidence(family, request.gateway, body, request.headers);
    const rule = CACHE_RULES[gateway || family === 'bedrock-anthropic' ? 'anthropic' : family];
    const shape = cacheShape(family, body, { gateway: request.gateway });
    const url = new URL(request.url ?? 'https://pi-sim.invalid');
    const scope = JSON.stringify([family, request.gateway ?? '', url.origin, body.model ?? '', modelResource(family, url), body.prompt_cache_key ?? '']);
    const cache = caches.get(scope) ?? [];
    const live = cache.filter(entry => entry.expiresAt > at);
    const prior = priorRequests.get(scope) ?? [];
    // A known branch can be revisited or extended. Compare it with its own live prefix,
    // rather than the immediately preceding request from a different branch.
    const matchingBranches = prior.filter(item => commonPrefix(item.blocks, shape.blocks) === item.blocks.length);
    const reference = matchingBranches.reduce((best, item) => !best || item.blocks.length >= best.blocks.length ? item : best, undefined) ?? prior.at(-1);
    const commonBlocks = reference ? commonPrefix(reference.blocks, shape.blocks) : 0;
    const explicit = ['anthropic', 'bedrock-anthropic', 'bedrock'].includes(family);
    let hitBlocks = 0;
    for (const entry of live) {
      const matches = commonPrefix(entry.blocks, shape.blocks) === entry.blocks.length;
      // Anthropic searches the 20 blocks ending at each current breakpoint.
      const reachable = !explicit || shape.markers.some(mark => mark.end >= entry.blocks.length && (family === 'bedrock' || shape.lookbackPositions[mark.end - 1] - shape.lookbackPositions[entry.blocks.length - 1] < 20));
      if (matches && reachable) {
        hitBlocks = Math.max(hitBlocks, entry.blocks.length);
        if (completedSuccess) entry.expiresAt = request.completedAt + entry.ttlMs;
      }
    }
    const protectedBlocks = reference ? Math.max(0, ...live.filter(entry => commonPrefix(entry.blocks, reference.blocks) === entry.blocks.length).map(entry => entry.blocks.length)) : 0;
    const expired = cache.length > 0 && live.length === 0;
    const prefixBreak = Boolean(reference && protectedBlocks > 0 && commonBlocks < protectedBlocks);
    const providerRule = { authority: 'provider', evidence: rule.evidence, source: rule.url };
    // Prefix stability is our extension-verification policy. Provider docs supply its premise.
    const prefixPolicy = { authority: 'policy', evidence: gateway?.nativeTransition ? 'advisory' : rule.evidence, source: 'hc-pi-sim:stable-cache-prefix', basis: rule.url };
    const current = { sequence: request.sequence ?? assessments.length, family, providerRule, prefixPolicy,
      ...(gateway ? { gateway, cacheEstimate: 'advisory: synthetic retention; gateway marks and cache hits are not simulated' } : {}),
      blocks: shape.blocks.length, commonBlocks, hitBlocks, protectedBlocks, expired,
      prefixBreak, referenceSequence: reference?.sequence ?? null, markers: shape.markers, issues: shape.issues,
      eligibility: 'unverified: model token minimum, hidden scaffolding, routing and server availability excluded' };
    assessments.push(current);
    for (const issue of shape.issues) violations.push({ sequence: current.sequence, family, ...providerRule, ...issue });
    if (prefixBreak) violations.push({ sequence: current.sequence, family, ...prefixPolicy, property: 'stable-cache-prefix', commonBlocks, protectedBlocks });
    if (completedSuccess) {
      const writes = explicit ? shape.markers : [{ end: shape.blocks.length, ttlMs: implicitTtlMs }];
      for (const mark of writes) {
        if (!mark.end) continue;
        const blocks = shape.blocks.slice(0, mark.end);
        const existing = live.find(entry => entry.blocks.length === blocks.length && commonPrefix(entry.blocks, blocks) === blocks.length);
        if (existing) { existing.expiresAt = (request.completedAt ?? at) + mark.ttlMs; existing.ttlMs = mark.ttlMs; }
        else live.push({ blocks, ttlMs: mark.ttlMs, expiresAt: (request.completedAt ?? at) + mark.ttlMs });
      }
    }
    caches.set(scope, live);
    if (completedSuccess) prior.push({ blocks: shape.blocks, sequence: current.sequence });
    priorRequests.set(scope, prior);
  }
  const providerPassed = !violations.some(v => v.authority === 'provider' && v.evidence === 'documented');
  const policyFailed = violations.some(v => v.authority === 'policy' && v.evidence === 'documented');
  const incomplete = assessments.some(a => a.gateway?.nativeTransition);
  const policyPassed = policyFailed ? false : incomplete ? null : true;
  const passed = !providerPassed || policyFailed ? false : incomplete ? null : true;
  return { assessments, violations, providerPassed, policyPassed, passed,
    verdict: passed === null ? 'advisory' : passed ? 'pass' : 'fail',
    structuralPassed: !assessments.some(a => a.prefixBreak),
    advisory: [...violations.filter(v => v.evidence === 'advisory'), ...assessments.flatMap(a => (a.gateway?.limitations ?? []).map(item => ({ sequence: a.sequence, ...item })))] };
}

export function assertCacheSafe(requests, options) {
  const result = checkCacheHistory(requests, options);
  if (!result.passed) {
    const error = new Error(`cache properties failed: ${JSON.stringify(result.violations)}`);
    error.trace = requests; error.assessment = result; throw error;
  }
  return result;
}
