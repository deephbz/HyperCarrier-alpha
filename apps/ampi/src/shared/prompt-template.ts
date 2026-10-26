/** pi's template arguments: $1…$9, $@ and $ARGUMENTS; arguments are appended when the template names none. */
export function expandTemplate(body: string, arg: string): string {
	const words = arg.trim() ? arg.trim().split(/\s+/) : [];
	let used = false;
	const out = body
		.replace(/\$ARGUMENTS|\$@/g, () => ((used = true), arg.trim()))
		.replace(/\$([1-9])/g, (_, n: string) => ((used = true), words[Number(n) - 1] ?? ""));
	return used || !arg.trim() ? out.trim() : `${out.trim()}\n\n${arg.trim()}`;
}
