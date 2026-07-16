const SERVICE_CONFIG = Object.freeze({
  timeline: { env: "PI_TIMELINE_PORT", defaultPort: 4318 },
  live: { env: "PI_LIVE_DETAIL_PORT", defaultPort: 4319 },
  tps: { env: "PI_TPS_ADAPTER_PORT", defaultPort: 4320 },
  traffic: { env: "PI_TRAFFIC_PORT", defaultPort: 4321 },
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

/** Process-local fixture adapters for an installed Timeline; never serialized as configuration. */
export function resolveTimelineSourceOptions(env = process.env) {
  const sessionsRoot = env.PI_TIMELINE_SESSIONS_ROOT;
  const teamsRoot = env.PI_TIMELINE_TEAMS_ROOT;
  return {
    ...(sessionsRoot ? { sessionsRoot } : {}),
    ...(teamsRoot ? { teamsRoot } : {}),
  };
}

export function resolveTrafficBaseUrl(env = process.env) {
  const fallback = `http://127.0.0.1:${resolveServicePort("traffic", env, { allowGenericPort: false })}`;
  const configured = env.PI_TRAFFIC_BASE_URL ?? fallback;
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("PI_TRAFFIC_BASE_URL must be a valid local HTTP URL");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "traffic.pi.localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("PI_TRAFFIC_BASE_URL must be an origin on an allowlisted loopback host");
  return url.origin;
}

export function namedUpstreamsFromEnv(env = process.env) {
  return new Map([
    ["pi.localhost", resolveServicePort("timeline", env, { allowGenericPort: false })],
    ["live.pi.localhost", resolveServicePort("live", env, { allowGenericPort: false })],
    ["tps.pi.localhost", resolveServicePort("tps", env, { allowGenericPort: false })],
    ["traffic.pi.localhost", resolveServicePort("traffic", env, { allowGenericPort: false })],
  ]);
}
