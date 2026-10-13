import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://shab:shab@localhost:5432/shabcrm_test" },
  },
});
