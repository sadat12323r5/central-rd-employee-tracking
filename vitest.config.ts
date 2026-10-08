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
    coverage: {
      include: ["src/domain/**/*.ts", "src/server/**/*.ts", "src/components/**/*.tsx"],
    },
  },
});
