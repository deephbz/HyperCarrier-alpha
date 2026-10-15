// Scripted public wire protocols. These fixtures never bypass Pi's request builders/parsers.
import { validateRequest } from './request-contract.mjs';
const sse = events => events.map(event => `event: ${event.type ?? 'message'}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const dataSse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const usage = reply => ({ input: 4096, output: 8, cacheRead: 0, cacheWrite: 0, ...reply.usage });

// https://platform.claude.com/docs/en/api/messages-streaming
export function anthropicEvents(reply, id, model) {
  const u = usage(reply), events = [{ type: 'message_start', message: {
    id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: u.input, output_tokens: 0, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite },
  } }];
  let index = 0;
  if (reply.text !== undefined || !reply.toolCalls?.length) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text: reply.text ?? 'ok' } },
      { type: 'content_block_stop', index });
    index++;
  }
  for (const call of reply.toolCalls ?? []) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id ?? `${id}_tool_${index}`, name: call.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments ?? {}) } },
      { type: 'content_block_stop', index });
    index++;
  }
  events.push({ type: 'message_delta', delta: { stop_reason: reply.stopReason ?? (reply.toolCalls?.length ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { output_tokens: u.output } }, { type: 'message_stop' });
  return events;
}

// https://platform.openai.com/docs/api-reference/responses-streaming
export function responsesEvents(reply, id, model) {
  const u = usage(reply), events = [], output = [];
  const response = { id, object: 'response', created_at: 1800000000, model, status: 'in_progress', output: [] };
  events.push({ type: 'response.created', response });
  if (reply.text !== undefined || !reply.toolCalls?.length) {
    const item = { id: `${id}_msg`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    events.push({ type: 'response.output_item.added', output_index: 0, item: structuredClone(item) },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: reply.text ?? 'ok' });
    item.status = 'completed'; item.content = [{ type: 'output_text', text: reply.text ?? 'ok', annotations: [] }];
    events.push({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: reply.text ?? 'ok' },
      { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
      { type: 'response.output_item.done', output_index: 0, item });
    output.push(item);
  }
  for (const call of reply.toolCalls ?? []) {
    const index = output.length;
    const item = { type: 'function_call', id: `${id}_fc_${index}`, call_id: call.id ?? `${id}_call_${index}`, name: call.name, arguments: '', status: 'in_progress' };
    events.push({ type: 'response.output_item.added', output_index: index, item: structuredClone(item) },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: JSON.stringify(call.arguments ?? {}) });
    item.arguments = JSON.stringify(call.arguments ?? {}); item.status = 'completed';
    events.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments }, { type: 'response.output_item.done', output_index: index, item });
    output.push(item);
  }
  events.push({ type: 'response.completed', response: { ...response, status: 'completed', output,
    usage: { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output, input_tokens_details: { cached_tokens: u.cacheRead }, output_tokens_details: { reasoning_tokens: 0 } } } });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

// https://platform.openai.com/docs/api-reference/chat/streaming
function completionEvents(reply, id, model) {
  const u = usage(reply);
  const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created: 1800000000, model, choices: [{ index: 0, delta, finish_reason }] });
  const events = [chunk({ role: 'assistant', content: reply.text ?? (reply.toolCalls?.length ? null : 'ok') })];
  if (reply.toolCalls?.length) events.push(chunk({ tool_calls: reply.toolCalls.map((call, index) => ({ index, id: call.id ?? `${id}_tool_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })) }));
  events.push(chunk({}, reply.toolCalls?.length ? 'tool_calls' : 'stop'));
  events.push({ id, object: 'chat.completion.chunk', created: 1800000000, model, choices: [], usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output, prompt_tokens_details: { cached_tokens: u.cacheRead } } });
  return events;
}

// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
function googleEvents(reply, id, model) {
  const u = usage(reply), parts = [];
  if (reply.text !== undefined || !reply.toolCalls?.length) parts.push({ text: reply.text ?? 'ok' });
  for (const call of reply.toolCalls ?? []) parts.push({ functionCall: { id: call.id, name: call.name, args: call.arguments ?? {} } });
  return [{ candidates: [{ content: { role: 'model', parts }, finishReason: reply.stopReason ?? 'STOP', index: 0 }], modelVersion: model, responseId: id,
    usageMetadata: { promptTokenCount: u.input, candidatesTokenCount: u.output, totalTokenCount: u.input + u.output, cachedContentTokenCount: u.cacheRead } }];
}

// https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
export function bedrockEvents(reply) {
  const u = usage(reply), events = [{ messageStart: { role: 'assistant' } }];
  let index = 0;
  if (reply.text !== undefined || !reply.toolCalls?.length) {
    events.push({ contentBlockDelta: { contentBlockIndex: index, delta: { text: reply.text ?? 'ok' } } }, { contentBlockStop: { contentBlockIndex: index++ } });
  }
  for (const call of reply.toolCalls ?? []) {
    events.push({ contentBlockStart: { contentBlockIndex: index, start: { toolUse: { toolUseId: call.id ?? `call_${index}`, name: call.name } } } },
      { contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input: JSON.stringify(call.arguments ?? {}) } } } }, { contentBlockStop: { contentBlockIndex: index++ } });
  }
  events.push({ messageStop: { stopReason: reply.toolCalls?.length ? 'tool_use' : 'end_turn' } }, { metadata: { usage: { inputTokens: u.input, outputTokens: u.output, totalTokens: u.input + u.output, cacheReadInputTokens: u.cacheRead, cacheWriteInputTokens: u.cacheWrite }, metrics: { latencyMs: 1 } } });
  return events;
}

// AWS event-stream framing: https://smithy.io/2.0/aws/amazon-eventstream.html
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
export function encodeAwsEvents(events) {
  return Buffer.concat(events.map(event => {
    const type = Object.keys(event)[0];
    const headers = Buffer.concat(Object.entries({ ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' }).map(([key, value]) => {
      const a = Buffer.from(key), b = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16BE(b.length);
      return Buffer.concat([Buffer.from([a.length]), a, Buffer.from([7]), length, b]);
    }));
    const body = Buffer.from(JSON.stringify(event[type])), result = Buffer.alloc(16 + headers.length + body.length);
    result.writeUInt32BE(result.length, 0); result.writeUInt32BE(headers.length, 4); result.writeUInt32BE(crc32(result.subarray(0, 8)), 8);
    headers.copy(result, 12); body.copy(result, 12 + headers.length);
    result.writeUInt32BE(crc32(result.subarray(0, -4)), result.length - 4);
    return result;
  }));
}

export class ScriptedProvider {
  constructor({ family, gateway, replies = [], scheduler, record }) {
    this.family = family; this.gateway = gateway;
    this.responder = typeof replies === 'function' ? replies : undefined;
    this.replies = this.responder ? [] : [...replies];
    this.scheduler = scheduler; this.record = record; this.requests = []; this.failures = [];
  }
  async fetch(input, init = {}) {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).hostname !== 'pi-sim.invalid') {
      const error = new Error(`network escape rejected: ${new URL(request.url).hostname}`);
      this.failures.push(error.message); throw error;
    }
    let body;
    try { body = JSON.parse(await request.text()); } catch { throw new Error('scripted endpoint expects JSON'); }
    return this.respond(request.url, body, request.signal, Object.fromEntries(['anthropic-beta', 'content-type', 'x-magpie-cache-marks'].filter(name => request.headers.has(name)).map(name => [name, request.headers.get(name)])));
  }
  async respond(url, body, signal, headers = {}) {
    const index = this.requests.length;
    const request = { sequence: index, at: this.scheduler.now, family: this.family, ...(this.gateway ? { gateway: this.gateway } : {}), url, headers, body: structuredClone(body), outcome: 'pending' };
    this.requests.push(request); this.record('request', request);
    try {
      const response = await this.reply(request, signal);
      request.status = response.status;
      request.outcome = 'completed';
      request.completedAt = this.scheduler.now;
      return response;
    } catch (error) {
      if (request.outcome === 'pending') request.outcome = signal?.aborted ? 'aborted' : 'transport-error';
      throw error;
    } finally {
      request.endedAt = this.scheduler.now;
      this.record('response', { request: index, outcome: request.outcome, status: request.status, completedAt: request.completedAt, endedAt: request.endedAt });
    }
  }
  async reply(request, signal) {
    const { sequence: index, body } = request;
    const issues = validateRequest(this.family, body);
    if (issues.length) {
      request.outcome = 'rejected';
      this.failures.push(`request contract failed: ${JSON.stringify(issues)}`);
      throw new Error(this.failures.at(-1));
    }
    const scripted = this.responder ?? this.replies.shift();
    let reply;
    try {
      reply = typeof scripted === 'function'
        ? await scripted(structuredClone(request), { entropy: this.scheduler.entropy, now: this.scheduler.now })
        : scripted;
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error(`unscripted provider request ${index}`);
    } catch (error) {
      this.failures.push(`reply script failed: ${error.message}`);
      throw error;
    }
    await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
      const abort = () => { this.scheduler.cancel(handle); reject(signal.reason ?? new Error('aborted')); };
      const handle = this.scheduler.schedule(() => { signal?.removeEventListener('abort', abort); resolve(); }, reply.delayMs ?? 0, 'provider.reply');
      signal?.addEventListener('abort', abort, { once: true });
    });
    if (reply.throw) throw new Error(reply.throw);
    if (reply.status && reply.status >= 400) return new Response(JSON.stringify({ type: 'error', error: { type: reply.errorType ?? 'api_error', message: reply.error ?? 'scripted provider failure' } }), { status: reply.status, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
    const id = `sim_${index}`, model = body.model ?? 'sim-model';
    let payload, contentType = 'text/event-stream';
    switch (this.family) {
      case 'anthropic': payload = sse(anthropicEvents(reply, id, model)); break;
      // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModelWithResponseStream.html
      // Raw Bedrock Anthropic wraps each Messages event in a binary chunk envelope.
      case 'bedrock-anthropic':
        payload = encodeAwsEvents(anthropicEvents(reply, id, model).map(event => ({ chunk: { bytes: Buffer.from(JSON.stringify(event)).toString('base64') } })));
        contentType = 'application/vnd.amazon.eventstream'; break;
      case 'openai-responses': payload = sse(responsesEvents(reply, id, model)); break;
      case 'openai-completions': payload = dataSse(completionEvents(reply, id, model)) + 'data: [DONE]\n\n'; break;
      case 'google': case 'vertex': payload = dataSse(googleEvents(reply, id, model)); break;
      case 'bedrock': payload = encodeAwsEvents(bedrockEvents(reply)); contentType = 'application/vnd.amazon.eventstream'; break;
      default: throw new Error(`unsupported provider family: ${this.family}`);
    }
    return new Response(payload, { status: 200, headers: { 'content-type': contentType, 'request-id': id, 'x-amzn-requestid': id } });
  }
  assertConsumed() {
    if (this.failures.length) throw new Error(this.failures.join('; '));
    if (this.replies.length) throw new Error(`${this.replies.length} scripted replies unused`);
  }
}
