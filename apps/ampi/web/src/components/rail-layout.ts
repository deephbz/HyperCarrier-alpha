// The prompt rail's geometry (CompanionScrollbar): one pure function from prompts, the reader's place and the strip's
// height to what the rail draws. The cap is part of the layout, not a CSS clip.

/** The rail's pitch: one 2 px dash and its gap. */
const PITCH = 6;
/** The rail is a short stack: at most this many dashes, and at most this share of its frame's height. */
const MAX_DASHES = 40;
const MAX_SHARE = 0.4;
/** A Session with fewer prompts has no rail: the transcript keeps its native scrollbar, and the prompt header steps through them. */
export const MIN_PROMPTS = 8;
/** Find marks closer than this merge into one. */
const MERGE_PX = 3;

/** A Find match on the rail, placed in prompt units: its prompt's index, plus a half when it lies in that prompt's answer. */
export type RailFind = { id: string; at: number; cur: boolean };
/** The rail as drawn: the prompts that show a dash, and the Find marks, in px from the strip's top. */
export type RailLayout = { shown: ReadonlySet<number>; marks: { id: string; y: number; cur: boolean }[] };

/**
 * The rail's one layout: from the prompt count, the prompts on screen and the strip's height to the dashes and marks.
 * Below MIN_PROMPTS there is no rail. Past the cap, the rail samples prompts at even steps that depend only on the
 * prompt count and the cap, so the samples hold still while the reader scrolls; a prompt on screen always shows and
 * takes the place of the nearest sample that is not on screen.
 * The stack is centered. A Find mark sits at its place between the dashes around it; marks closer than MERGE_PX merge,
 * and a merged mark is current when any of its matches is.
 */
export function railLayout(prompts: number, inView: ReadonlySet<number>, height: number, finds: readonly RailFind[] = []): RailLayout | undefined {
 if (prompts < MIN_PROMPTS) return undefined;
 const cap = Math.max(MIN_PROMPTS, Math.min(MAX_DASHES, Math.floor((height * MAX_SHARE) / PITCH)));
 const shown = new Set<number>();
 for (let k = 0; k < Math.min(cap, prompts); k++) shown.add(Math.floor((k * prompts) / Math.min(cap, prompts)));
 for (const i of [...inView].filter((i) => i >= 0 && i < prompts && !shown.has(i)).sort((a, b) => a - b)) {
  for (let d = 1; d < prompts; d++) {
   const near = [i - d, i + d].find((j) => shown.has(j) && !inView.has(j));
   if (near !== undefined) { shown.delete(near); break; }
  }
  shown.add(i);
 }
 const order = [...shown].sort((a, b) => a - b);
 const last = order.length - 1;
 const top = (height - order.length * PITCH) / 2;
 const slot = (at: number) => {
  if (at <= order[0]!) return Math.max(-0.5, at - order[0]!);
  let k = 0;
  while (k < last && order[k + 1]! <= at) k++;
  return k === last ? k + Math.min(0.5, at - order[k]!) : k + (at - order[k]!) / (order[k + 1]! - order[k]!);
 };
 const marks: RailLayout["marks"] = [];
 for (const find of [...finds].sort((a, b) => a.at - b.at)) {
  const y = top + slot(find.at) * PITCH + PITCH / 2;
  const prev = marks[marks.length - 1];
  if (prev && y - prev.y < MERGE_PX) prev.cur ||= find.cur;
  else marks.push({ id: find.id, y, cur: find.cur });
 }
 return { shown, marks };
}
