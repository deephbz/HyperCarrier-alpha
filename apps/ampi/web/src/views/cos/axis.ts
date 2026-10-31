// Short Timeline axis labels for a phone (cos.css shows them at 600 px or less). Each label stays exact: the range picks
// the coarsest unit that still tells its ticks apart, and a label never drops characters to fit.
const DAY = 86_400_000;

export function shortTick(t: number, from: number, to: number, locales: Intl.LocalesArgument = []): string {
	const at = new Date(t);
	const time = at.toLocaleTimeString(locales, { hour: "numeric", minute: "2-digit" });
	if (new Date(from).toDateString() === new Date(to).toDateString()) return time;
	// Under six days, a weekday names one day; at six or more, the first and last ticks could share a weekday.
	if (to - from < 6 * DAY) return `${at.toLocaleDateString(locales, { weekday: "short" })} ${time}`;
	if (to - from < 300 * DAY) return at.toLocaleDateString(locales, { month: "short", day: "numeric" });
	return at.toLocaleDateString(locales, { month: "short", year: "numeric" });
}
