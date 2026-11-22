/** A localized count followed by its singular or regular plural noun. */
export function countLabel(count: number, noun: string): string {
	return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
