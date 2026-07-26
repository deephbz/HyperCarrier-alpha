import net from "node:net";

const SOURCE = "rarebit:activity";
const APPLIES_TO_SOURCE = "herdr:pi";
const REFRESH_MS = 30_000;
const TTL_MS = 90_000;

function socketEndpoint(env) {
  const path = env.HERDR_SOCKET_PATH;
  if (!path) return null;
  return process.platform === "win32" ? `\\\\.\\pipe\\${path}` : path;
}

function durationLabel(timestamp, now) {
  if (typeof timestamp !== "string") return null;
  const elapsed = now - Date.parse(timestamp);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const totalMinutes = Math.floor(elapsed / 60_000);
  if (totalMinutes < 1) return "now";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m`;
}

export function herdrActivityTokens(activity, now = Date.now()) {
  return {
    rarebit_user_age: durationLabel(activity?.latestUser?.timestamp, now),
    rarebit_stop_age: durationLabel(activity?.latestAgentStop?.timestamp, now),
  };
}

function sendHerdrRequest(endpoint, request, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const socket = net.createConnection(endpoint);
    socket.on("error", finish);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", finish);
    socket.on("end", finish);
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

/** Optional Herdr adapter; no connection or timer is created outside Herdr. */
export function createHerdrActivityReporter({
  env = process.env,
  now = () => Date.now(),
  send = sendHerdrRequest,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const endpoint = env.HERDR_ENV === "1" ? socketEndpoint(env) : null;
  const paneId = env.HERDR_PANE_ID;
  let sequence = Date.now() * 1000;
  let activity = null;
  let timer = null;

  const report = () => {
    if (!endpoint || !paneId) return;
    sequence += 1;
    void send(endpoint, {
      id: `${SOURCE}:${sequence}`,
      method: "pane.report_metadata",
      params: {
        pane_id: paneId,
        source: SOURCE,
        applies_to_source: APPLIES_TO_SOURCE,
        seq: sequence,
        ttl_ms: TTL_MS,
        tokens: herdrActivityTokens(activity, now()),
      },
    });
  };

  return {
    start(nextActivity) {
      activity = nextActivity;
      if (timer) clearIntervalFn(timer);
      report();
      if (endpoint && paneId) {
        timer = setIntervalFn(report, REFRESH_MS);
        timer.unref?.();
      }
    },
    update(nextActivity) {
      activity = nextActivity;
      report();
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
      activity = null;
      report();
    },
  };
}
