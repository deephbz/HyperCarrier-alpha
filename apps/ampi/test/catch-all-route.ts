import type { Page, Route } from "playwright";

type Handler = (route: Route) => void | Promise<void>;

/** Route fixture pages without intercepting browser-owned blob/data resources or allowing real network requests. */
export function catchAllRoute(page: Page, origin: string, handle: Handler) {
	return page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.protocol === "blob:" || url.protocol === "data:") return route.continue();
		if (url.origin !== origin) return route.abort();
		return handle(route);
	});
}
