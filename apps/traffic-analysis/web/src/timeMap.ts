import type { Row } from "./types";
import { field } from "./types";

export type GlobalGap = { startMs: number; endMs: number; hiddenMs: number };
export type DisplayTick = { y: number; utcMs: number; label: string };

/** Rendering-only UTC ↔ compressed-display mapper. Backend global_quiet_gap rows own gap semantics. */
export class CompressedTimeMap {
  readonly hiddenMs: number;
  readonly displaySpanMs: number;
  readonly drawableHeight: number;
  readonly scale: number;

  constructor(
    readonly startMs: number,
    readonly endMs: number,
    readonly top: number,
    readonly bottom: number,
    readonly gaps: readonly GlobalGap[],
    readonly breakPx = 18,
  ) {
    this.hiddenMs = gaps.reduce((total, gap) => total + gap.hiddenMs, 0);
    this.displaySpanMs = Math.max(1, endMs - startMs - this.hiddenMs);
    this.drawableHeight = Math.max(1, bottom - top - gaps.length * breakPx);
    this.scale = this.drawableHeight / this.displaySpanMs;
  }

  toY(utcMs: number): number {
    let hiddenBefore = 0;
    let bandsBefore = 0;
    for (const gap of this.gaps) {
      if (utcMs >= gap.endMs) {
        hiddenBefore += gap.hiddenMs;
        bandsBefore++;
        continue;
      }
      if (utcMs > gap.startMs) {
        return (
          this.top +
          (gap.startMs - this.startMs - hiddenBefore) * this.scale +
          bandsBefore * this.breakPx +
          this.breakPx / 2
        );
      }
      break;
    }
    return (
      this.top +
      (utcMs - this.startMs - hiddenBefore) * this.scale +
      bandsBefore * this.breakPx
    );
  }

  /** Maps a display coordinate to UTC. A coordinate inside a break maps to the gap midpoint. */
  toUtc(y: number): number {
    let hiddenBefore = 0;
    let bandsBefore = 0;
    for (const gap of this.gaps) {
      const bandStart =
        this.top +
        (gap.startMs - this.startMs - hiddenBefore) * this.scale +
        bandsBefore * this.breakPx;
      if (y < bandStart)
        return (
          this.startMs +
          (y - this.top - bandsBefore * this.breakPx) / this.scale +
          hiddenBefore
        );
      if (y <= bandStart + this.breakPx) return gap.startMs + gap.hiddenMs / 2;
      hiddenBefore += gap.hiddenMs;
      bandsBefore++;
    }
    return Math.min(
      this.endMs,
      Math.max(
        this.startMs,
        this.startMs +
          (y - this.top - bandsBefore * this.breakPx) / this.scale +
          hiddenBefore,
      ),
    );
  }

  breakBands(): Array<{ top: number; bottom: number; gap: GlobalGap }> {
    let hiddenBefore = 0;
    return this.gaps.map((gap, index) => {
      const top =
        this.top +
        (gap.startMs - this.startMs - hiddenBefore) * this.scale +
        index * this.breakPx;
      hiddenBefore += gap.hiddenMs;
      return { top, bottom: top + this.breakPx, gap };
    });
  }

  ticks(count = 5): DisplayTick[] {
    const result: DisplayTick[] = [];
    for (let index = 0; index < count; index++) {
      const y =
        this.top + (this.bottom - this.top) * (index / Math.max(1, count - 1));
      result.push({
        y,
        utcMs: this.toUtc(y),
        label: new Date(this.toUtc(y)).toISOString().slice(11, 16) + " UTC",
      });
    }
    return result;
  }
}

export function globalGaps(rows: Row[]): GlobalGap[] {
  return rows
    .map((row) => ({
      startMs: field<number>(row, "start_ms") ?? null,
      endMs: field<number>(row, "end_ms") ?? null,
    }))
    .filter(
      (gap): gap is { startMs: number; endMs: number } =>
        gap.startMs !== null && gap.endMs !== null && gap.endMs > gap.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs)
    .reduce<GlobalGap[]>((accepted, gap) => {
      const previous = accepted.at(-1);
      if (!previous || gap.startMs >= previous.endMs)
        accepted.push({ ...gap, hiddenMs: gap.endMs - gap.startMs });
      return accepted;
    }, []);
}
