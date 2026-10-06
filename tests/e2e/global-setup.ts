import { randomBytes, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "./supabase-admin";

// Creates throwaway accounts and rows for this run, following the RLS-test convention of dedicated
// test accounts created and removed by the test itself (never the seeded demo employees):
// - an Administrator (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD);
// - three throwaway employees (BS-98nn, team/title "E2E Throwaway"): two linked to Staff users
//   (E2E_STAFF_1_* / E2E_STAFF_2_*), one left unlinked for the provisioning spec (E2E_STAFF_UNLINKED_*).
// global-teardown.ts deletes all of them. Leftovers of an aborted run (older than two hours) are swept first.
// Staff users are created directly through the service role here (test setup is the AD-6 exception).

export const STAFF_EMAIL_PREFIX = "e2e-staff-";
export const ADMIN_EMAIL_PREFIX = "e2e-admin-";
export const THROWAWAY_ID_PATTERN = "BS-98%";

/** Leftovers older than this are from an aborted run; younger ones may belong to a run still in progress. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Deletes auth users whose email starts with `prefix`, optionally only those created before `createdBefore`. */
export async function deleteUsersByPrefix(service: SupabaseClient, prefix: string, createdBefore?: Date) {
  const doomed: string[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not list users: ${error.message}`);
    doomed.push(...data.users
      .filter(u => u.email?.startsWith(prefix) && (!createdBefore || Date.parse(u.created_at) < createdBefore.getTime()))
      .map(u => u.id));
    if (data.users.length < 1000) break;
  }
  for (const id of doomed) await service.auth.admin.deleteUser(id);
}

const throwawayRow = (employee_id: string, name: string, email: string) => ({
  employee_id, name, title: "E2E Throwaway", team: "E2E Throwaway", employment_type: "Permanent", email,
  joined_on: "2026-01-01", manager: "E2E", office: "E2E", status: "Available", initials: "ET",
  avatar_color: "mint", summary: "Throwaway row created by tests/e2e/global-setup.ts.",
});

export default async function globalSetup() {
  const service = serviceClient();
  const runId = randomBytes(4).toString("hex");

  // Sweep leftovers of a run killed before teardown. Only items older than two hours are removed,
  // so an overlapping run on the shared project (say local and CI) keeps its own accounts and rows.
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
  await deleteUsersByPrefix(service, STAFF_EMAIL_PREFIX, staleBefore);
  await deleteUsersByPrefix(service, ADMIN_EMAIL_PREFIX, staleBefore);
  const swept = await service.from("employees").delete().like("employee_id", THROWAWAY_ID_PATTERN).lt("created_at", staleBefore.toISOString());
  if (swept.error) throw new Error(`Could not sweep throwaway employees: ${swept.error.message}`);

  const email = `${ADMIN_EMAIL_PREFIX}${runId}@example.test`;
  const password = `E2e-${randomBytes(18).toString("base64url")}`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: "admin" } });
  if (error || !data.user) throw new Error(`Could not create the e2e Administrator: ${error?.message ?? "no user returned"}`);
  process.env.E2E_ADMIN_ID = data.user.id;
  process.env.E2E_ADMIN_EMAIL = email;
  process.env.E2E_ADMIN_PASSWORD = password;

  const base = randomInt(0, 33) * 3;
  const staff = [1, 2, 3].map(n => ({
    id: `BS-98${String(base + n - 1).padStart(2, "0")}`,
    name: `E2E Staff ${["One", "Two", "Three"][n - 1]} ${runId}`,
    email: `${STAFF_EMAIL_PREFIX}${runId}-${n}@example.test`,
  }));
  process.env.E2E_STAFF_RUN = runId;
  process.env.E2E_STAFF_IDS = staff.map(s => s.id).join(",");

  const inserted = await service.from("employees").insert(staff.map(s => throwawayRow(s.id, s.name, s.email)));
  if (inserted.error) throw new Error(`Could not insert throwaway employees: ${inserted.error.message}`);

  for (const [index, member] of staff.slice(0, 2).entries()) {
    const staffPassword = `E2e-${randomBytes(18).toString("base64url")}`;
    const created = await service.auth.admin.createUser({
      email: member.email, password: staffPassword, email_confirm: true, app_metadata: { role: "staff", employee_id: member.id },
    });
    if (created.error || !created.data.user) throw new Error(`Could not create an e2e Staff user: ${created.error?.message ?? "no user returned"}`);
    const linked = await service.from("employees").update({ auth_user_id: created.data.user.id }).eq("employee_id", member.id);
    if (linked.error) throw new Error(`Could not link an e2e Staff user: ${linked.error.message}`);
    process.env[`E2E_STAFF_${index + 1}_EMAIL`] = member.email;
    process.env[`E2E_STAFF_${index + 1}_PASSWORD`] = staffPassword;
    process.env[`E2E_STAFF_${index + 1}_ID`] = member.id;
  }

  const unlinked = staff[2];
  process.env.E2E_STAFF_UNLINKED_ID = unlinked.id;
  process.env.E2E_STAFF_UNLINKED_NAME = unlinked.name;
  process.env.E2E_STAFF_UNLINKED_EMAIL = unlinked.email;
}
