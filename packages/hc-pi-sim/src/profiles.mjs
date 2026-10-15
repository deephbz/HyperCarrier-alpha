// Synthetic provider fixtures use Pi's real models.json loader. No personal config is read.
export function magpieProfile({ compat = {}, headers = {}, model = {} } = {}) {
  return {
    family: 'openai-completions', gateway: 'anthropic',
    providerEntry: {
      id: 'magpie',
      config: {
        api: 'openai-completions', baseUrl: 'https://pi-sim.invalid/v1', apiKey: 'synthetic-not-a-credential',
        headers, compat: { sendSessionAffinityHeaders: true, ...compat },
        models: [{ id: 'claude/sim-model', name: 'Synthetic Claude gateway model', reasoning: false,
          input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000, maxTokens: 4096, ...model }],
      },
    },
  };
}

export const MAGPIE_SOURCE = 'https://github.com/yetone/magpie/blob/122e655aacbb6e26b733ceb786e95dfc9cb57a3c/internal/gateway/chat.go';

export function gatewayEvidence(family, gateway, body, headers = {}) {
  if (gateway === undefined) return undefined;
  if (gateway !== 'anthropic' || family !== 'openai-completions') throw new Error('unsupported gateway profile');
  const optIn = Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'x-magpie-cache-marks' && value === 'client');
  let conversation = false, nativeTransition = false;
  for (const message of body.messages ?? []) {
    if (!['system', 'developer'].includes(message.role)) conversation = true;
    else if (conversation) nativeTransition = true;
  }
  // HC .pi/skills/verify-pi-magpie/SKILL.md and features/client-cache-marks.md:
  // X-Magpie-Cache-Marks: client applies to /v1/messages, never /v1/chat/completions.
  // features/anthropic-api-relay.md records gateway-added 5m Chat marks on relay.
  // Bridge placement/run reuse is not modeled here. No client marks are treated as writes.
  return {
    profile: 'anthropic-over-chat', projection: 'client-structure', nativeTransition,
    cacheMarks: { requestedOptIn: optIn, effect: 'ignored-on-chat', clientMarksHonored: false },
    limitations: [
      { property: 'gateway-cache-placement', evidence: 'advisory', reason: 'Bridge marks, retention and run reuse need an outgoing gateway capture.' },
      ...(nativeTransition ? [{ property: 'gateway-native-transition', evidence: 'advisory', source: MAGPIE_SOURCE,
        reason: 'cRequest.Messages has no tools field; parseChat hoists system/developer messages. Native tool additions are not preserved by this source.' }] : []),
    ],
  };
}
