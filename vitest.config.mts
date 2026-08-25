import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Loaded here, in the config, so the values are present before any worker
// imports a module that reads process.env at module scope (better-auth does).
loadEnv();

export default defineConfig({
  test: {
    environment: "node",
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "",
      BASE_URL: process.env.BASE_URL ?? "http://localhost:3000",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    },
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Integration tests share one PostgreSQL database, so they must not race.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
