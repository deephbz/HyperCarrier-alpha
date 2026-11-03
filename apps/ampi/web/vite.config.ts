import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
// @ts-ignore: a plain ESM script without types
import { webInputsPlugin } from "../scripts/web-inputs.mjs";

const DEV_HUB = "127.0.0.1:7878";

/**
 * `dev:web` serves its own index.html, and the hub serves writes only to a page of its build. This plugin copies the
 * build meta from the page the dev hub serves. Without a dev hub the page has no build and only reads.
 */
function devHubBuild(): Plugin {
	return {
		name: "ampi-dev-hub-build",
		apply: "serve",
		async transformIndexHtml(html) {
			const served = await fetch(`http://${DEV_HUB}/`).then((r) => r.text()).catch(() => "");
			const meta = /<meta name="ampi-build" content="[^"]*" \/>/.exec(served)?.[0];
			return meta ? html.replace("</head>", `${meta}\n</head>`) : html;
		},
	};
}

export default defineConfig({
	root: new URL(".", import.meta.url).pathname,
	// The stamp lets demo and verify hubs refuse a stale web/dist (scripts/web-inputs.mjs).
	plugins: [react(), webInputsPlugin(new URL("../../..", import.meta.url).pathname), devHubBuild()],
	build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
	server: { proxy: { "/ws": { target: `ws://${DEV_HUB}`, ws: true } } },
});
