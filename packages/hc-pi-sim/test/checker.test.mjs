import "./home.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCacheHistory, cacheShape, fc, explore } from '../src/index.mjs';

const marker = { type: 'ephemeral' };
const text = (value, cached = true) => ({ type: 'text', text: value, ...(cached ? { cache_control: marker } : {}) });
const message = (value, cached = true) => ({ role: 'user', content: [text(value, cached)] });
const request = (body, at = 0, family = 'anthropic') => ({ body, at, family, url: 'https://pi-sim.invalid/v1/messages', outcome: 'completed', status: 200, completedAt: at });
const body = { model: 'synthetic', system: [text('stable')], messages: [message('one')] };

test('golden structural prefix: tools precede system; messages append', () => {
  const first = { ...body, tools: [{ name: 'a', input_schema: { type: 'object' }, cache_control: marker }] };
  const second = { ...first, messages: [...first.messages, message('two')] };
  let result = checkCacheHistory([request(first), request(second, 1000)]);
  assert.equal(result.assessments[1].hitBlocks, 3);
  assert.equal(result.passed, true);
  result = checkCacheHistory([request(first), request({ ...second, tools: [{ ...first.tools[0], description: 'changed' }] }, 1000)]);
  assert.equal(result.assessments[1].commonBlocks, 0);
  assert.equal(result.passed, false);
  result = checkCacheHistory([request(first), request({ ...second, system: [text('changed')] }, 1000)]);
  assert.equal(result.assessments[1].hitBlocks, 1);
  assert.equal(result.passed, false);
});

test('marker names inside tool arguments and schemas remain cache content', () => {
  for (const field of ['cache_control', 'cachePoint']) {
    for (const position of ['input', 'schema']) {
      const make = value => position === 'input'
        ? { model: 'synthetic', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'test', input: { [field]: value }, cache_control: marker }] }] }
        : { model: 'synthetic', tools: [{ name: 'test', input_schema: { type: 'object', properties: { [field]: { type: 'string', description: value } } }, cache_control: marker }], messages: [] };
      const result = checkCacheHistory([request(make('old')), request(make('new'), 1)]);
      assert.equal(result.passed, false, `${position}.${field}`);
      assert.equal(result.assessments[1].hitBlocks, 0);
    }
    const bedrock = value => ({ messages: [{ role: 'assistant', content: [{ toolUse: { toolUseId: 'call', name: 'test', input: { [field]: value } } }, { cachePoint: { type: 'default' } }] }] });
    assert.equal(checkCacheHistory([request(bedrock('old'), 0, 'bedrock'), request(bedrock('new'), 1, 'bedrock')]).passed, false);
  }
  // Moving a real protocol marker does not change the cached content.
  assert.deepEqual(cacheShape('anthropic', { messages: [message('one')] }).blocks,
    cacheShape('anthropic', { messages: [message('one', false)] }).blocks);
});

test('20-block lookup boundary is independent of shared-prefix length', () => {
  const start = { model: 'synthetic', messages: [message('first')] };
  for (const distance of [19, 20]) {
    const next = { ...start, messages: [message('first', false), ...Array.from({ length: distance }, (_, i) => message(`new-${i}`, i === distance - 1))] };
    const assessment = checkCacheHistory([request(start), request(next, 10)]).assessments[1];
    assert.equal(assessment.commonBlocks, 1);
    assert.equal(assessment.hitBlocks, distance === 19 ? 1 : 0);
  }
});

test('Claude lookback groups consecutive tool blocks but preserves exact matching', () => {
  const start = { model: 'synthetic', messages: [message('first')] };
  for (const type of ['tool_use', 'tool_result']) {
    const blocks = Array.from({ length: 25 }, (_, i) => type === 'tool_use'
      ? { type, id: `call-${i}`, name: 'anchor', input: {} }
      : { type, tool_use_id: `call-${i}`, content: 'result' });
    const next = { ...start, messages: [message('first', false), { role: type === 'tool_use' ? 'assistant' : 'user', content: [...blocks.slice(0, -1), { ...blocks.at(-1), cache_control: marker }] }] };
    assert.equal(checkCacheHistory([request(start), request(next, 1)]).assessments[1].hitBlocks, 1);
    const separated = { ...next, messages: [message('first', false), { role: next.messages[1].role,
      content: blocks.flatMap((block, i) => [block, text(`separator-${i}`, i === 24)]) }] };
    assert.equal(checkCacheHistory([request(start), request(separated, 1)]).assessments[1].hitBlocks, 0);
    const changed = structuredClone(next); changed.messages[1].content[4].extra = 'changed';
    assert.equal(checkCacheHistory([request(next), request(changed, 1)]).assessments[1].prefixBreak, true);
  }
});

test('returning to or extending a live cached branch uses that branch as reference', () => {
  const a = { model: 'synthetic', messages: [message('branch A')] };
  const b = { model: 'synthetic', messages: [message('branch B'), message('longer B')] };
  for (const returned of [a, { ...a, messages: [...a.messages, message('new A')] }]) {
    const result = checkCacheHistory([request(a), request(b, 1), request(returned, 2)]);
    // B introduces a new prefix. Returning to the previously cached A is not another break.
    assert.equal(result.assessments[1].prefixBreak, true);
    assert.equal(result.assessments[2].referenceSequence, 0);
    assert.equal(result.assessments[2].hitBlocks, 1);
    assert.equal(result.assessments[2].prefixBreak, false);
    assert.equal(result.violations.filter(v => v.sequence === 2).length, 0);
  }
  const mutated = checkCacheHistory([request(a), request({ ...a, messages: [message('corrupt A')] }, 1)]);
  assert.equal(mutated.assessments[1].prefixBreak, true);
});

test('TTL resets on hits and expires at exact boundary; 1h entries live longer', () => {
  const one = request(body);
  let result = checkCacheHistory([one, request(body, 299999), request(body, 599998)]);
  assert.equal(result.assessments[2].hitBlocks, 2);
  result = checkCacheHistory([one, request(body, 300000)]);
  assert.equal(result.assessments[1].hitBlocks, 0);
  assert.equal(result.assessments[1].expired, true);
  const long = { ...body, system: [text('stable', false)], messages: [{ role: 'user', content: [{ ...text('one'), cache_control: { type: 'ephemeral', ttl: '1h' } }] }] };
  result = checkCacheHistory([request(long), request(long, 3599999)]);
  assert.equal(result.assessments[1].hitBlocks, 2);
});

test('provider constraints and prefix policy carry separate authority and verdicts', () => {
  const invalid = checkCacheHistory([request({ messages: Array.from({ length: 5 }, (_, i) => message(String(i))) })]);
  assert.equal(invalid.providerPassed, false);
  assert.equal(invalid.policyPassed, true);
  assert.equal(invalid.violations[0].authority, 'provider');
  assert.equal(invalid.violations[0].evidence, 'documented');
  const policy = checkCacheHistory([request(body), request({ ...body, system: [text('changed')] }, 1)]);
  assert.equal(policy.providerPassed, true);
  assert.equal(policy.policyPassed, false);
  assert.equal(policy.passed, false);
  const violation = policy.violations.find(v => v.property === 'stable-cache-prefix');
  assert.equal(violation.authority, 'policy');
  assert.equal(violation.source, 'hc-pi-sim:stable-cache-prefix');
  assert.match(violation.basis, /platform.claude.com/);
  assert.equal(policy.assessments[1].providerRule.authority, 'provider');
  assert.equal(policy.assessments[1].prefixPolicy.authority, 'policy');
});

test('marker limits, TTL ordering and invalid TTL cannot silently pass', () => {
  assert.equal(cacheShape('anthropic', { messages: Array.from({ length: 5 }, (_, i) => message(String(i))) }).issues[0].property, 'marker-limit');
  const mixed = { system: [text('short')], messages: [{ role: 'user', content: [{ ...text('long'), cache_control: { type: 'ephemeral', ttl: '1h' } }] }] };
  assert.equal(cacheShape('anthropic', mixed).issues[0].property, 'long-ttl-before-short');
  assert.equal(cacheShape('anthropic', { system: [{ ...text('bad'), cache_control: { type: 'ephemeral', ttl: '2h' } }] }).issues[0].property, 'valid-ttl');
});

test('only completed successes populate or refresh cache; missing outcomes stay unknown', () => {
  for (const mutation of [{ outcome: undefined, status: undefined, completedAt: undefined }, { outcome: 'aborted', completedAt: undefined }, { outcome: 'rejected' }, { outcome: 'transport-error' }, { outcome: 'completed', completedAt: undefined }]) {
    const failed = { ...request(body), ...mutation };
    assert.equal(checkCacheHistory([failed, request(body, 1)]).assessments[1].hitBlocks, 0);
    const result = checkCacheHistory([request(body), { ...failed, at: 299999 }, request(body, 300001)]);
    assert.equal(result.assessments[2].hitBlocks, 0, JSON.stringify(mutation));
  }
});

test('HTTP 400/500 cache-shaped failures cannot refresh a live TTL', () => {
  for (const status of [400, 500]) {
    const result = checkCacheHistory([
      request(body), { ...request(body, 299999), status }, request(body, 300001),
    ]);
    assert.equal(result.assessments[1].hitBlocks, 2, 'content could match, but the failed outcome cannot refresh it');
    assert.equal(result.assessments[2].hitBlocks, 0, String(status));
    assert.equal(result.assessments[2].expired, true, String(status));
  }
});

test('failed requests do not populate cache; cache writes happen after response completion', () => {
  const result = checkCacheHistory([{ ...request(body), status: 400 }, request(body, 10)]);
  assert.equal(result.assessments[1].hitBlocks, 0);
  const delayed = checkCacheHistory([{ ...request(body), completedAt: 10000, status: 200 }, request(body, 305000)]);
  assert.equal(delayed.assessments[1].hitBlocks, 2);
});

test('Bedrock cachePoint participates in cache lookup and TTL', () => {
  const first = { system: [{ text: 'fixed' }, { cachePoint: { type: 'default' } }], messages: [{ role: 'user', content: [{ text: 'one' }, { cachePoint: { type: 'default' } }] }] };
  const second = { ...first, messages: [...first.messages, { role: 'user', content: [{ text: 'two' }] }] };
  const result = checkCacheHistory([request(first, 0, 'bedrock'), request(second, 10, 'bedrock')]);
  assert.equal(result.assessments[1].hitBlocks, 2);
  assert.equal(result.passed, true);
  assert.equal(checkCacheHistory([request(first, 0, 'bedrock'), request({ ...second, system: [{ text: 'changed' }] }, 10, 'bedrock')]).passed, false);
});

test('implicit providers expose advisory evidence; key/model/endpoint partition cache', () => {
  for (const family of ['openai-responses', 'openai-completions', 'google', 'vertex']) {
    const first = family === 'google' || family === 'vertex' ? { contents: [{ role: 'user', parts: [{ text: 'one' }] }] } : { model: 'synthetic', input: [{ role: 'user', content: 'one' }] };
    const changed = family === 'google' || family === 'vertex' ? { contents: [{ role: 'user', parts: [{ text: 'changed' }] }] } : { ...first, input: [{ role: 'user', content: 'changed' }] };
    const result = checkCacheHistory([request(first, 0, family), request(changed, 1, family)]);
    assert.equal(result.passed, true);
    assert.equal(result.advisory[0].property, 'stable-cache-prefix');
  }
  for (const mutation of [{ model: 'another' }, { prompt_cache_key: 'different' }]) {
    const result = checkCacheHistory([request(body, 0, 'openai-responses'), request({ ...body, ...mutation }, 1, 'openai-responses')]);
    assert.equal(result.assessments[1].hitBlocks, 0);
  }
  assert.equal(checkCacheHistory([request(body), { ...request(body, 1), url: 'https://other.invalid' }]).assessments[1].hitBlocks, 0);
});

test('URL model resources partition Bedrock, Gemini and Vertex cache scopes', () => {
  const cases = [
    ['bedrock', '/model/a/converse-stream', '/model/b/converse-stream', { system: [{ text: 'fixed' }, { cachePoint: { type: 'default' } }], messages: [] }],
    ['google', '/v1beta/models/a:streamGenerateContent', '/v1beta/models/b:streamGenerateContent', { contents: [{ role: 'user', parts: [{ text: 'fixed' }] }] }],
    ['vertex', '/v1/projects/p/locations/l/publishers/google/models/a:streamGenerateContent', '/v1/projects/p/locations/l/publishers/google/models/b:streamGenerateContent', { contents: [{ role: 'user', parts: [{ text: 'fixed' }] }] }],
  ];
  for (const [family, firstPath, secondPath, content] of cases) {
    const first = { ...request(content, 0, family), url: `https://pi-sim.invalid${firstPath}?alt=sse` };
    const same = { ...request(content, 1, family), url: `https://pi-sim.invalid${firstPath}?alt=sse&irrelevant=true` };
    const different = { ...same, url: `https://pi-sim.invalid${secondPath}?alt=sse` };
    assert.ok(checkCacheHistory([first, same]).assessments[1].hitBlocks > 0, family);
    assert.equal(checkCacheHistory([first, different]).assessments[1].hitBlocks, 0, family);
  }
});

test('generated append-only histories preserve live explicit prefixes', async () => {
  await explore(fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 2, maxLength: 12 }), async values => {
    const requests = values.map((_v, i) => request({ messages: values.slice(0, i + 1).map((value, j) => message(value, j === i)) }, i * 100));
    const result = checkCacheHistory(requests);
    assert.equal(result.passed, true);
    for (let i = 1; i < values.length; i++) assert.equal(result.assessments[i].hitBlocks, i);
  }, { seed: 401, numRuns: 50 });
});

test('fast-check helper returns a shrunk replay seed/path for failures', async () => {
  await assert.rejects(explore(fc.integer({ min: 1, max: 100 }), async value => { assert.equal(value, 0); }, { seed: 41, numRuns: 5 }), error => {
    assert.equal(error.result.failed, true);
    assert.deepEqual(error.result.counterexample, [1]);
    assert.equal(typeof error.result.counterexamplePath, 'string');
    return true;
  });
});
