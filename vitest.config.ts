import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@core": path.resolve(import.meta.dirname, "src/core") } },
  test: { setupFiles: ["./vitest.setup.ts"], include: ["tests/**/*.test.ts", "web/src/**/*.test.ts"], testTimeout: 20000 },
});
