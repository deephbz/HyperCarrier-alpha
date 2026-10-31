import type { ReactNode } from "react";

/** One option: its value, visible label and optional tooltip. */
export type Segment<T extends string> = readonly [value: T, label: ReactNode, title?: string];

/**
 * One choice among a few options, all shown: a labelled group of toggle buttons, and exactly the chosen one is
 * pressed. `aria-pressed` is the only selected state; `.seg button[aria-pressed="true"]` draws it, so the drawn and
 * the announced choice cannot differ.
 */
export function Segmented<T extends string>({ label, value, options, onChange, className }: { label: string; value: T; options: readonly Segment<T>[]; onChange: (value: T) => void; className?: string }) {
	return (
		<div className={className ? `seg ${className}` : "seg"} role="group" aria-label={label}>
			{options.map(([option, text, title]) => (
				<button key={option} type="button" aria-pressed={option === value} title={title} onClick={() => option !== value && onChange(option)}>
					{text}
				</button>
			))}
		</div>
	);
}
