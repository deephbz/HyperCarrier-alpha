/** `[start, tokens, dollars]`; index 1 or 2 selects the unit. */
export type Bucket = [number, number, number];
export type Unit = 1 | 2;
type Life = { start: number; end: number };

/** A merged Team lane draws and totals the sum of its members' buckets. */
export function mergeBuckets(members: { buckets: Bucket[] }[]): Bucket[] {
	const sums = new Map<number, Bucket>();
	for (const member of members) for (const b of member.buckets) {
		const sum = sums.get(b[0]) ?? [b[0], 0, 0]; sum[1] += b[1]; sum[2] += b[2]; sums.set(b[0], sum);
	}
	return [...sums.values()].sort((a, b) => a[0] - b[0]);
}

/** The time a lane draws for one bucket: the bucket clipped to the lane's life, at least one second. */
export function drawnSpan(b: Bucket, life: Life, bucketMs: number): [number, number] {
	return [Math.max(life.start, b[0]), Math.min(Math.max(life.end, life.start + 1000), b[0] + bucketMs)];
}

/**
 * A lane's total over a range equals its drawn area: each bucket counts in proportion to the part of its drawn span
 * inside the range. Ranges on bucket edges, or covering the lane's life, give exact bucket sums.
 */
export function laneTotal(buckets: Bucket[], life: Life, range: [number, number], bucketMs: number, unit: Unit): number {
	let total = 0;
	for (const b of buckets) {
		const [start, end] = drawnSpan(b, life, bucketMs);
		const inside = Math.min(end, range[1]) - Math.max(start, range[0]);
		if (end > start && inside > 0) total += b[unit] * inside / (end - start);
	}
	return total;
}
