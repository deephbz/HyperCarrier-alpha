import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: new URL(".", import.meta.url).pathname,
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
	server: { proxy: { "/ws": { target: "ws://127.0.0.1:7878", ws: true } } },
});
