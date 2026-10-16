-- Story 7.1: add a new employee.
-- ADDITIVE only: two new insert policies on public.employees. No column, constraint, index, function or
-- existing policy is altered or tightened, and no update or delete policy is added.
--
-- * The Administrator may insert an employee into any department; a department manager only into a
--   department in their subtree (public.manages_department, from the manager_scope migration, walks up
--   the authority chain). Staff have no insert policy, so their inserts are refused (42501).
-- * employees.department_id stays nullable at the column (making it NOT NULL would be a tightening while
--   seeded rows may lack it); both policies require it, so every employee added through the app has one.
-- * A new employee never starts linked to a sign-in account (accounts are created only through
--   accounts-store, Story 1.3) and never starts archived.
-- * Uniqueness of the Employee ID (primary key) and primary email (unique) is the existing constraints'.
-- The app's employees-store re-checks the same department authority before inserting (defence in depth).

create policy "employees_insert_admin" on public.employees
  for insert to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    and department_id is not null
    and auth_user_id is null
    and archived_at is null
  );

create policy "employees_insert_managed" on public.employees
  for insert to authenticated
  with check (
    department_id is not null
    and public.manages_department(department_id)
    and auth_user_id is null
    and archived_at is null
  );

-- No update or delete policies.
