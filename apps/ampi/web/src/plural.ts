/** The noun for a count: `plural(1, "tool use")` is "tool use", `plural(5, "tool use")` is "tool uses". Every count label uses it. */
export function plural(n: number, one: string, many = `${one}s`): string {
	return n === 1 ? one : many;
}
