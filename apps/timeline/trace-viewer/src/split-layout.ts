/**
 * Shared split geometry. The inspector maximum derives from the measured
 * workspace and a usable ledger minimum, not a fixed pixel cap, so the
 * 30:70 default and wide drags stay monotone.
 */
export const INSPECTOR_MIN_WIDTH = 320;
export const LEDGER_MIN_WIDTH = 280;

/** The largest inspector width that still leaves a usable ledger. */
export function inspectorMaximumWidth(workspaceWidth: number): number {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) return INSPECTOR_MIN_WIDTH;
  return Math.max(INSPECTOR_MIN_WIDTH, workspaceWidth - LEDGER_MIN_WIDTH);
}

/** Clamp a requested inspector width to the measured workspace bounds. */
export function clampInspectorWidth(width: number, workspaceWidth: number): number {
  const maximum = inspectorMaximumWidth(workspaceWidth);
  if (!Number.isFinite(width)) return maximum;
  return Math.min(maximum, Math.max(INSPECTOR_MIN_WIDTH, width));
}

/** The rendered default before any drag: 70% of the measured workspace. */
export function inspectorDefaultWidth(workspaceWidth: number): number {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) return INSPECTOR_MIN_WIDTH;
  return clampInspectorWidth(workspaceWidth * 0.7, workspaceWidth);
}

/** The width actually rendered for a requested value, including the default. */
export function constrainedInspectorWidth(
  requested: number | null,
  workspaceWidth: number,
): number {
  return requested === null
    ? inspectorDefaultWidth(workspaceWidth)
    : clampInspectorWidth(requested, workspaceWidth);
}

/** Pointer drag keeps leftward motion monotone after clamping. */
export function inspectorWidthFromDrag(
  startWidth: number,
  startClientX: number,
  clientX: number,
  workspaceWidth: number,
): number {
  return clampInspectorWidth(startWidth + (startClientX - clientX), workspaceWidth);
}
