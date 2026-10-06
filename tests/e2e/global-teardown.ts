import { serviceClient } from "./supabase-admin";

export default async function globalTeardown() {
  const id = process.env.E2E_ADMIN_ID;
  if (!id) return;
  const { error } = await serviceClient().auth.admin.deleteUser(id);
  if (error) console.error(`Could not delete the e2e Administrator ${process.env.E2E_ADMIN_EMAIL}: ${error.message}`);
}
