-- Story 4.3: managers see only their own department (and its sub-departments).
-- ADDITIVE only: two new functions and new select-only policies. No existing policy, column or function
-- is altered or tightened, and no insert, update or delete policy is added (managers write nothing here).
--
-- * A manager's scope is every department whose authority chain contains the manager's account: the
--   department itself or any ancestor (walking parent_department_id) has manager_user_id = auth.uid().
--   This is the authority rule (AD-4) read from the other end, so scope and later write checks agree.
-- * public.manages_department(dept) and public.manages_employee(emp) answer that question for the
--   signed-in user. They are SECURITY DEFINER because a manager must not be able to read the department
--   and employee rows the walk passes through; they expose only a boolean about auth.uid().
-- * The recursive walk uses UNION (not UNION ALL), which de-duplicates rows, so a cycle in the stored
--   hierarchy still terminates (the departments_prevent_cycle trigger should make that impossible).
-- * The app's manager-scope helper re-derives the same scope at the store (defence in depth, AD-1).
-- Interviews get no manager policy: interviews are never visible to managers.

create function public.manages_department(dept uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  with recursive chain (id, parent_department_id, manager_user_id) as (
    select d.id, d.parent_department_id, d.manager_user_id
      from public.departments d
      where d.id = dept
    union
    select p.id, p.parent_department_id, p.manager_user_id
      from public.departments p
      join chain c on p.id = c.parent_department_id
  )
  select auth.uid() is not null and exists (select 1 from chain where chain.manager_user_id = auth.uid());
$$;

create function public.manages_employee(emp text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  with recursive chain (id, parent_department_id, manager_user_id) as (
    select d.id, d.parent_department_id, d.manager_user_id
      from public.departments d
      join public.employees e on e.department_id = d.id
      where e.employee_id = emp
    union
    select p.id, p.parent_department_id, p.manager_user_id
      from public.departments p
      join chain c on p.id = c.parent_department_id
  )
  select auth.uid() is not null and exists (select 1 from chain where chain.manager_user_id = auth.uid());
$$;

-- Signed-in users only. anon is revoked explicitly too, since Supabase's default privileges grant it
-- execute on new public functions (without a signed-in user the answer would be false anyway).
revoke execute on function public.manages_department(uuid) from public, anon;
revoke execute on function public.manages_employee(text) from public, anon;
grant execute on function public.manages_department(uuid) to authenticated;
grant execute on function public.manages_employee(text) to authenticated;

-- A manager reads the departments in their subtree (the departments they manage and every descendant).
create policy "departments_select_managed_subtree" on public.departments
  for select to authenticated
  using (public.manages_department(id));

-- A manager reads the employees in their subtree, and those employees' attendance, training and LMS rows.
create policy "employees_select_managed" on public.employees
  for select to authenticated
  using (public.manages_employee(employee_id));

create policy "attendance_select_managed" on public.attendance_entries
  for select to authenticated
  using (public.manages_employee(employee_id));

create policy "training_history_select_managed" on public.training_history
  for select to authenticated
  using (public.manages_employee(employee_id));

create policy "lms_stub_enrolments_select_managed" on public.lms_stub_enrolments
  for select to authenticated
  using (public.manages_employee(employee_id));

-- No insert, update or delete policies.
