import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@core": path.resolve(import.meta.dirname, "../src/core") } },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
    fs: { allow: [path.resolve(import.meta.dirname, "..")] },
  },
  build: { outDir: path.resolve(import.meta.dirname, "../dist"), emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
