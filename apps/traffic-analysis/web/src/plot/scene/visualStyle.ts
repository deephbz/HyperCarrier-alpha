import type { MatrixMark } from "../../matrixTypes";

export const trafficPalette = {
  paper: "#f6f4ed",
  surface: "#fffefa",
  inspector: "#eeece4",
  ink: "#1b1b1b",
  muted: "#3d4551",
  rule: "#3d4551",
  userRequest: "#1a4480",
  agentContinuation: "#216e4e",
  agentStop: "#0f5132",
  requestInterval: "#2e6f95",
  toolObservation: "#765aab",
  userAlert: "#b45309",
  agentTruncated: "#b91c1c",
  quietGap: "#8a8477",
  gapBand: "#e9e5d9",
  selection: "#b91c1c",
  selectionHalo: "#fffefa",
  focus: "#005ea2",
} as const;

export type TrafficMarkStyle = Readonly<{
  stroke: string;
  fill: string;
  symbol: "square" | "circle" | "line";
  lineWidth: number;
  radius: number;
  z: number;
  hollow?: boolean;
}>;
export type DisplayKind = MatrixMark["display"]["kind"];

export const trafficMarkStyle = (kind: DisplayKind): TrafficMarkStyle => {
  switch (kind) {
    case "user_request":
      return {
        stroke: trafficPalette.userRequest,
        fill: trafficPalette.userRequest,
        symbol: "square",
        lineWidth: 2,
        radius: 7,
        z: 50,
      };
    case "user_alert":
      return {
        stroke: trafficPalette.userAlert,
        fill: trafficPalette.userAlert,
        symbol: "square",
        lineWidth: 2,
        radius: 7,
        z: 51,
      };
    case "agent_continuation":
      return {
        stroke: trafficPalette.agentContinuation,
        fill: trafficPalette.surface,
        symbol: "circle",
        lineWidth: 2.5,
        radius: 4.5,
        z: 40,
        hollow: true,
      };
    case "agent_stop":
      return {
        stroke: trafficPalette.agentStop,
        fill: trafficPalette.agentStop,
        symbol: "circle",
        lineWidth: 2,
        radius: 6.5,
        z: 50,
      };
    case "agent_truncated":
    case "agent_response_unavailable":
      return {
        stroke: trafficPalette.agentTruncated,
        fill: trafficPalette.surface,
        symbol: "circle",
        lineWidth: 2.5,
        radius: 6.5,
        z: 52,
        hollow: true,
      };
    case "tool_observation":
      return {
        stroke: trafficPalette.toolObservation,
        fill: trafficPalette.toolObservation,
        symbol: "line",
        lineWidth: 3,
        radius: 0,
        z: 20,
      };
    case "quiet_gap":
      return {
        stroke: trafficPalette.quietGap,
        fill: trafficPalette.quietGap,
        symbol: "line",
        lineWidth: 1,
        radius: 0,
        z: 0,
      };
  }
};

export const glyphStyle = (glyph: { role: string; mark: MatrixMark }) =>
  glyph.role === "request_interval"
    ? ({
        stroke: trafficPalette.requestInterval,
        fill: trafficPalette.requestInterval,
        symbol: "line",
        lineWidth: 7,
        radius: 0,
        z: 10,
      } satisfies TrafficMarkStyle)
    : glyph.role === "tool_span"
      ? trafficMarkStyle("tool_observation")
      : glyph.role === "quiet_after_stop" || glyph.role === "global_break"
        ? trafficMarkStyle("quiet_gap")
        : trafficMarkStyle(glyph.mark.display.kind);
