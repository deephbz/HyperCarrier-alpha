/**
 * Display units. AmPi sets the display size with CSS `zoom` on the page (`ampi.display` overall) and on its regions
 * (App.tsx), so one screen holds two units. Rects, pointer coordinates and `innerWidth`/`innerHeight` are screen px.
 * CSS lengths (`width`, `left`, `top`, `height`) and `scrollTop`, `offsetWidth`, `clientHeight` are the element's own
 * CSS px, which the element's effective zoom multiplies. Convert at the element that owns the length; region zoom
 * and body portals give elements different scales, so never use one global zoom.
 */

/**
 * The border-box width of `el` in its own CSS px, unrounded. `offsetWidth` rounds to a whole px; at a region zoom the
 * width is fractional, and a long scroll multiplies the scale's error (0.04 % moved a 4,700 px restore by 3 px).
 */
function cssWidth(el: Element) {
	if (typeof getComputedStyle !== "function") return (el as HTMLElement).offsetWidth;
	const style = getComputedStyle(el);
	const width = Number.parseFloat(style.width);
	if (!Number.isFinite(width)) return (el as HTMLElement).offsetWidth;
	if (style.boxSizing === "border-box") return width;
	const px = (value: string) => Number.parseFloat(value) || 0;
	return width + px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth);
}

/**
 * Screen px per CSS px of `el`, measured now. `css` is the CSS length that drew the box, by default its own border
 * box; pass it when another element's units declare that length (a grid column of the parent's CSS px).
 */
export function scaleOf(el: Element, css = cssWidth(el)): number {
	const scale = el.getBoundingClientRect().width / css;
	return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** A screen-px distance as CSS px of `el`. */
export const toCss = (px: number, el: Element) => px / scaleOf(el);

/** A CSS-px distance of `el` as screen px. */
export const toScreen = (px: number, el: Element) => px * scaleOf(el);
