import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Supabase credentials (from .env.local locally, repository secrets in CI) enable the RLS
// integration tests; without them those tests skip. Only the Supabase variables are loaded.
const supabaseEnv = loadEnv("test", process.cwd(), ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    env: supabaseEnv,
    setupFiles: ["./tests/setup.ts"],
    // The live RLS tests share one Supabase project and their throwaway rows overlap, so test files
    // run one at a time; tests inside a file still run in order as before.
    fileParallelism: false,
    // Live RLS tests make several round trips to the shared project per test; 5s was too tight in CI.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      include: ["src/domain/**/*.ts", "src/server/**/*.ts", "src/components/**/*.tsx"],
    },
  },
});
