const DEFAULT_TRACE_VIEWER_ORIGIN = "http://127.0.0.1:4319";

function traceViewerOrigin() {
  return process.env.PI_LIVE_DETAIL_BASE_URL ?? DEFAULT_TRACE_VIEWER_ORIGIN;
}

function isAllowedTraceViewerOrigin(url) {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".pi.localhost")) &&
    url.username === "" &&
    url.password === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === ""
  );
}

export function traceViewerUrl(sessionId, origin = traceViewerOrigin()) {
  if (
    typeof sessionId !== "string" ||
    sessionId.trim() === "" ||
    sessionId === "." ||
    sessionId === ".."
  ) {
    throw new Error("Pi did not provide a safe current Session ID.");
  }
  const base = new URL(origin);
  if (!isAllowedTraceViewerOrigin(base)) {
    throw new Error("Trace Viewer origin must be an allowlisted loopback HTTP origin.");
  }
  base.pathname = `/session/${encodeURIComponent(sessionId)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function browserCommand() {
  if (process.platform === "darwin") return ["open", []];
  if (process.platform === "win32") return ["cmd", ["/c", "start", ""]];
  return ["xdg-open", []];
}

export default function viewTraceExtension(pi) {
  pi.registerCommand("view-trace", {
    description: "Open the current Pi Session in the local Trace Viewer",
    handler: async (_args, ctx) => {
      let url;
      try {
        url = traceViewerUrl(ctx.sessionManager.getSessionId());
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const [command, args] = browserCommand();
      try {
        const result = await pi.exec(command, [...args, url]);
        if (result.code !== 0) {
          ctx.ui.notify(
            `Could not open Trace Viewer (${result.stderr || result.code}). Copy this URL: ${url}`,
            "error",
          );
          return;
        }
      } catch (error) {
        ctx.ui.notify(
          `Could not open Trace Viewer (${error instanceof Error ? error.message : String(error)}). Copy this URL: ${url}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(
        `Opened Trace Viewer for Session ${ctx.sessionManager.getSessionId()}.`,
        "info",
      );
    },
  });
}
