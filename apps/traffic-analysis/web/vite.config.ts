import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": "http://127.0.0.1:4390" } },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
