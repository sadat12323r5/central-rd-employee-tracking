-- Story 4.2: the Administrator assigns a department manager.
-- ADDITIVE only: a new nullable column on departments (with its index) and a new select policy. No
-- existing column, constraint or policy is altered or tightened.
--
-- * departments.manager_user_id is the manager's sign-in account (an auth user id, not an Employee ID:
--   the seeded L&D manager is the Administrator account, which has no employee row). Null = no manager.
--   Deleting the auth user clears the reference (on delete set null); no app path deletes auth users.
-- * Only Administrators can set or clear it: the existing departments_update_admin policy is the only
--   update policy, and the app's departments-store checks the Administrator role first.
-- * A signed-in user may read the departments they manage (departments_select_managed). The app uses
--   this on every request to derive the `manager` session role for Staff accounts.
-- Seeding (L&D's manager = the Administrator) is done by scripts/seed-employees.ts, never by this migration.

alter table public.departments
  add column manager_user_id uuid null references auth.users (id) on delete set null;

create index departments_manager_user_id_idx on public.departments (manager_user_id);

create policy "departments_select_managed" on public.departments
  for select to authenticated
  using (manager_user_id = (select auth.uid()));
