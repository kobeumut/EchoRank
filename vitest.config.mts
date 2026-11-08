import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "@locales": path.resolve(import.meta.dirname, "locales") } },
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    // Pinned to `api` so the suite never falls back to a real claude/codex/agy installed on the machine.
    // GEO_AUDIT_BIN is blanked so a local .env (loaded by Prisma) cannot start a real audit runner in tests.
    env: { DATABASE_URL: "file:./test.db", NODE_ENV: "test", LLM_TRANSPORT: "api", GEO_AUDIT_BIN: "" },
    fileParallelism: false,
  },
});
