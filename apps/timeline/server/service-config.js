const SERVICE_CONFIG = Object.freeze({
  timeline: { env: "PI_TIMELINE_PORT", defaultPort: 4318 },
  live: { env: "PI_LIVE_DETAIL_PORT", defaultPort: 4319 },
  tps: { env: "PI_TPS_ADAPTER_PORT", defaultPort: 4320 },
});

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${name} must be an integer between 1 and 65535`);
  return port;
}

export function resolveServicePort(service, env = process.env, { allowGenericPort = true } = {}) {
  const definition = SERVICE_CONFIG[service];
  if (!definition) throw new Error(`Unknown Timeline service: ${service}`);
  if (env[definition.env] !== undefined) return parsePort(env[definition.env], definition.env);
  if (allowGenericPort && env.PORT !== undefined) return parsePort(env.PORT, "PORT");
  return definition.defaultPort;
}

export function resolveCoreHost() {
  return "127.0.0.1";
}

export function namedUpstreamsFromEnv(env = process.env) {
  return new Map([
    ["pi.localhost", resolveServicePort("timeline", env, { allowGenericPort: false })],
    ["live.pi.localhost", resolveServicePort("live", env, { allowGenericPort: false })],
    ["tps.pi.localhost", resolveServicePort("tps", env, { allowGenericPort: false })],
  ]);
}
