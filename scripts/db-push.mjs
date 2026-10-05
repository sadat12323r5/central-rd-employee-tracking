// Applies supabase/migrations to the shared Supabase project.
// Reads SUPABASE_DB_URL from the environment or .env.local and never prints it:
// the CLI's output is filtered so the URL (and its password) are masked if they ever appear.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (!process.env.SUPABASE_DB_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL is not set. Add it to .env.local (see docs/DEPLOYMENT.md).");
  process.exit(1);
}

const secrets = [dbUrl];
try {
  const password = decodeURIComponent(new URL(dbUrl).password);
  if (password) secrets.push(password, encodeURIComponent(password));
} catch { /* not a parseable URL; the CLI will report it without echoing it here */ }
const mask = text => secrets.reduce((out, secret) => out.split(secret).join("***"), text);

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("supabase/package.json")), "dist", "supabase.js");
// No shell: the URL is passed as a single argv entry, so it is never interpreted or echoed by a shell.
const child = spawn(process.execPath, [cli, "db", "push", "--db-url", dbUrl, "--yes"], { stdio: ["inherit", "pipe", "pipe"] });
child.stdout.on("data", chunk => process.stdout.write(mask(chunk.toString())));
child.stderr.on("data", chunk => process.stderr.write(mask(chunk.toString())));
child.on("close", code => process.exit(code ?? 1));
