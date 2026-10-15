// A bounded independent wire validator. Unknown fields are preserved for forward compatibility.
// This validates the documented envelope and tool-result joins; it is not a complete JSON Schema.
export function validateRequest(family, body) {
  const issues = [];
  const expect = (condition, property, path) => { if (!condition) issues.push({ property, path }); };
  expect(body && typeof body === 'object' && !Array.isArray(body), 'request-object', '$');
  if (!body || typeof body !== 'object') return issues;
  const calls = new Set();
  if (family === 'anthropic' || family === 'bedrock-anthropic') {
    // https://platform.claude.com/docs/en/api/messages
    if (family === 'anthropic') expect(typeof body.model === 'string' && body.model.length > 0, 'model-required', 'model');
    expect(Number.isInteger(body.max_tokens) && body.max_tokens > 0, 'positive-max-tokens', 'max_tokens');
    expect(Array.isArray(body.messages), 'messages-array', 'messages');
    for (const [i, message] of (Array.isArray(body.messages) ? body.messages : []).entries()) {
      // Native mid-conversation system messages: https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
      expect(['user', 'assistant', 'system'].includes(message.role), 'message-role', `messages[${i}]`);
      expect(typeof message.content === 'string' || Array.isArray(message.content), 'message-content', `messages[${i}].content`);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_use') { expect(typeof block.id === 'string' && typeof block.name === 'string', 'tool-use-identity', `messages[${i}]`); calls.add(block.id); }
        if (block.type === 'tool_result') expect(calls.has(block.tool_use_id), 'tool-result-join', `messages[${i}]`);
      }
    }
  } else if (family === 'openai-responses') {
    // https://platform.openai.com/docs/api-reference/responses/create
    expect(typeof body.model === 'string', 'model-required', 'model');
    expect(typeof body.input === 'string' || Array.isArray(body.input), 'responses-input', 'input');
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (item.type === 'function_call') calls.add(item.call_id);
      // Server-side previous_response_id may own calls absent from this request.
      if (item.type === 'function_call_output' && !body.previous_response_id) expect(calls.has(item.call_id), 'tool-result-join', 'input');
    }
  } else if (family === 'openai-completions') {
    // https://platform.openai.com/docs/api-reference/chat/create
    expect(typeof body.model === 'string', 'model-required', 'model');
    expect(Array.isArray(body.messages), 'messages-array', 'messages');
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      for (const call of message.tool_calls ?? []) calls.add(call.id);
      if (message.role === 'tool') expect(calls.has(message.tool_call_id), 'tool-result-join', 'messages');
    }
  } else if (family === 'google' || family === 'vertex') {
    // https://ai.google.dev/api/generate-content#request-body
    expect(Array.isArray(body.contents), 'contents-array', 'contents');
    for (const [i, content] of (Array.isArray(body.contents) ? body.contents : []).entries()) expect(Array.isArray(content.parts), 'parts-array', `contents[${i}].parts`);
  } else if (family === 'bedrock') {
    // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
    expect(Array.isArray(body.messages), 'messages-array', 'messages');
    for (const [i, message] of (Array.isArray(body.messages) ? body.messages : []).entries()) {
      expect(['user', 'assistant'].includes(message.role), 'message-role', `messages[${i}]`);
      expect(Array.isArray(message.content), 'content-array', `messages[${i}].content`);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.toolUse) calls.add(block.toolUse.toolUseId);
        if (block.toolResult) expect(calls.has(block.toolResult.toolUseId), 'tool-result-join', `messages[${i}]`);
      }
    }
  } else issues.push({ property: 'unsupported-family', path: family });
  return issues;
}
