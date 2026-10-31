import type { HTMLAttributes, ReactNode } from "react";

/**
 * One field with its controls: the Find bar, the palette's search row, the Session header. The field takes the free
 * width and never drops below `--field-min` (styles.css), or below the whole row when the row is narrower. The controls
 * stay as one group. They sit beside the field while both fit, wrap below it when not, and wrap among themselves on a
 * row narrower than the group. No control can squeeze the field or leave the row.
 */
export function FormRow({ field, children, className, ...props }: { field: ReactNode; children?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
	return <div {...props} className={className ? `form-row ${className}` : "form-row"}>
		<div className="form-field">{field}</div>
		<div className="form-actions">{children}</div>
	</div>;
}
