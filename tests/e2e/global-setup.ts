import { randomBytes } from "node:crypto";
import { serviceClient } from "./supabase-admin";

// Creates a throwaway Administrator for this run, following the RLS-test convention of dedicated
// test accounts created and removed by the test itself. Tests read it from E2E_ADMIN_EMAIL and
// E2E_ADMIN_PASSWORD; global-teardown.ts deletes it by E2E_ADMIN_ID.
export default async function globalSetup() {
  const runId = randomBytes(4).toString("hex");
  const email = `e2e-admin-${runId}@example.test`;
  const password = `E2e-${randomBytes(18).toString("base64url")}`;
  const { data, error } = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: "admin" } });
  if (error || !data.user) throw new Error(`Could not create the e2e Administrator: ${error?.message ?? "no user returned"}`);
  process.env.E2E_ADMIN_ID = data.user.id;
  process.env.E2E_ADMIN_EMAIL = email;
  process.env.E2E_ADMIN_PASSWORD = password;
}
