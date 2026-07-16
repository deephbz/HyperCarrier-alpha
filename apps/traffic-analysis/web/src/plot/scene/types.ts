import type { WallClockScene } from "./WallClockScene";

export type SceneRendererProps = {
  scene: WallClockScene;
  selectedEventRef: string | null;
  onHover: (eventRef: string | null) => void;
  onSelect: (eventRef: string) => void;
  /** Plotly-native y-axis gestures must route through the shared UTC window owner. */
  onWindowChange?: (window: { startMs: number; endMs: number }) => void;
  onResetWindow?: () => void;
};
