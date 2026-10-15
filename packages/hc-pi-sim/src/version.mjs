import manifest from '../package.json' with { type: 'json' };

// In 0.x, a minor changes the API contract; patches preserve it.
export const SIM_API_VERSION = manifest.version;
