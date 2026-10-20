import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// @ts-ignore: a plain ESM script without types
import { webInputsPlugin } from "../scripts/web-inputs.mjs";

export default defineConfig({
	root: new URL(".", import.meta.url).pathname,
	// The stamp lets demo and verify hubs refuse a stale web/dist (scripts/web-inputs.mjs).
	plugins: [react(), webInputsPlugin(new URL("../../..", import.meta.url).pathname)],
	build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
	server: { proxy: { "/ws": { target: "ws://127.0.0.1:7878", ws: true } } },
});
