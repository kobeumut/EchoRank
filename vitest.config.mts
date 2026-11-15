import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "@locales": path.resolve(import.meta.dirname, "locales") } },
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    env: { DATABASE_URL: "file:./test.db", NODE_ENV: "test" },
    fileParallelism: false,
  },
});
