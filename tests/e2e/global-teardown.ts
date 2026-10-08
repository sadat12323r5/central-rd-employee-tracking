import { deleteUsersByPrefix, STAFF_EMAIL_PREFIX } from "./global-setup";
import { serviceClient } from "./supabase-admin";

export default async function globalTeardown() {
  const service = serviceClient();
  const adminId = process.env.E2E_ADMIN_ID;
  if (adminId) {
    const { error } = await service.auth.admin.deleteUser(adminId);
    if (error) console.error(`Could not delete the e2e Administrator ${process.env.E2E_ADMIN_EMAIL}: ${error.message}`);
  }

  // This run's Staff users, including the one the provisioning spec created through the app.
  const runId = process.env.E2E_STAFF_RUN;
  if (runId) {
    try {
      await deleteUsersByPrefix(service, `${STAFF_EMAIL_PREFIX}${runId}-`);
    } catch (error) {
      console.error(`Could not delete the e2e Staff users: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const ids = process.env.E2E_STAFF_IDS?.split(",").filter(Boolean) ?? [];
  if (ids.length) {
    const { error } = await service.from("employees").delete().in("employee_id", ids);
    if (error) console.error(`Could not delete the throwaway employees: ${error.message}`);
  }
}
