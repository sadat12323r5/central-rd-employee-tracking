-- Story 4.5: managers create and close assignments.
-- ADDITIVE only: a new table with its indexes, a guard function + triggers and RLS policies. No existing
-- table, column, constraint, function or policy is altered.
--
-- * An assignment records what an employee did, for whom (client), on which project, in which role and
--   allocation, from which start date, and under which department. While open, only the "latest update"
--   note may change; closing sets the completion date and moves it into history. Nothing is ever deleted.
-- * At most one open assignment per employee (partial unique index assignments_one_open_per_employee).
-- * department_id is never the caller's choice: on insert the guard copies the employee's current
--   department (SECURITY DEFINER, so the caller need not be able to read the employee row) and refuses an
--   employee without one. Story 4.8 blocks transfers while an assignment is open, so for every writable
--   (open) row department_id equals the employee's current department; afterwards it never changes.
-- * Why a trigger and not column grants: it follows the external_interviews_guard precedent; it is purely
--   additive (no REVOKE of the default table privileges); it binds the service role too; and column
--   privileges cannot express the state-dependent rule (the note is editable only while open, a closed
--   row is frozen, and the only status change is open -> closed with a completion date).
-- * The guard raises check_violation (23514) for any refused change. A BEFORE DELETE trigger always
--   raises (service role included), and there is no delete policy.
-- * Policies: the Administrator (app_metadata.role = 'admin') and a manager over the employee's
--   department (public.manages_employee, the same authority chain the app's manager-scope uses) read,
--   insert and update; the employee reads their own rows (employees.auth_user_id = auth.uid()). Staff
--   never write.
-- The app's only writer is src/server/assignments-store.ts. Seeding (each fixture employee's former
-- "current work" as an open assignment) is done by scripts/seed-employees.ts, never by this migration.

create table public.assignments (
  id              uuid primary key default gen_random_uuid(),
  employee_id     text not null references public.employees (employee_id) on delete restrict,
  department_id   uuid not null references public.departments (id) on delete restrict,
  client          text not null check (client = btrim(client) and char_length(client) between 1 and 200),
  project_name    text not null check (project_name = btrim(project_name) and char_length(project_name) between 1 and 200),
  role            text not null check (role = btrim(role) and char_length(role) between 1 and 200),
  allocation      smallint not null check (allocation between 0 and 100),
  start_date      date not null,
  latest_update   text not null default '' check (char_length(latest_update) <= 2000),
  status          text not null default 'open' check (status in ('open', 'closed')),
  completion_date date null,
  created_at      timestamptz not null default now(),
  closed_at       timestamptz null,
  constraint assignments_status_dates check (
    (status = 'open' and completion_date is null and closed_at is null)
    or (status = 'closed' and completion_date is not null and completion_date >= start_date)
  )
);

-- At most one open assignment per employee.
create unique index assignments_one_open_per_employee on public.assignments (employee_id) where status = 'open';
-- Profiles read assignments per employee.
create index assignments_employee_id_idx on public.assignments (employee_id);

create or replace function public.assignments_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_department uuid;
begin
  if tg_op = 'INSERT' then
    -- The employee's real department, whatever the caller sent.
    select e.department_id into v_department from public.employees e where e.employee_id = new.employee_id;
    if v_department is null then
      raise exception 'employee % has no department', new.employee_id using errcode = '23514';
    end if;
    new.department_id := v_department;
    new.status := 'open';
    new.completion_date := null;
    new.closed_at := null;
    new.created_at := now();
    return new;
  end if;

  -- UPDATE. A closed assignment is frozen (an update that changes nothing is not a change).
  if old.status = 'closed' then
    if new is distinct from old then
      raise exception 'assignment % is closed and can no longer be changed', old.id using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
     or new.employee_id is distinct from old.employee_id
     or new.department_id is distinct from old.department_id
     or new.client is distinct from old.client
     or new.project_name is distinct from old.project_name
     or new.role is distinct from old.role
     or new.allocation is distinct from old.allocation
     or new.start_date is distinct from old.start_date
     or new.created_at is distinct from old.created_at then
    raise exception 'the identifying fields of an assignment cannot be changed' using errcode = '23514';
  end if;
  if new.status = 'closed' then
    -- open -> closed: the completion date is required (and checked against the start date by
    -- assignments_status_dates); the closing time is the database's, never a client-chosen value.
    if new.completion_date is null then
      raise exception 'closing an assignment needs a completion date' using errcode = '23514';
    end if;
    new.closed_at := now();
  elsif new.completion_date is not null or new.closed_at is not null then
    raise exception 'an open assignment has no completion date' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger assignments_guard
  before insert or update on public.assignments
  for each row execute function public.assignments_guard();

create or replace function public.assignments_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'assignments are never deleted' using errcode = '23514';
end;
$$;

-- Binds every role, the service role included.
create trigger assignments_no_delete
  before delete on public.assignments
  for each row execute function public.assignments_no_delete();

-- Trigger functions only: nobody calls them directly.
revoke execute on function public.assignments_guard() from public, anon, authenticated;
revoke execute on function public.assignments_no_delete() from public, anon, authenticated;

alter table public.assignments enable row level security;

-- Administrators read every assignment. Roles live in app_metadata, which only the service role can set.
create policy "assignments_select_admin" on public.assignments
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- A manager reads the assignments of the employees in their department subtree.
create policy "assignments_select_managed" on public.assignments
  for select to authenticated
  using (public.manages_employee(employee_id));

-- The employee reads their own assignments (read-only).
create policy "assignments_select_own" on public.assignments
  for select to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = assignments.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- The Administrator, or a manager over the employee's department, creates and updates assignments.
create policy "assignments_insert_authorized" on public.assignments
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' or public.manages_employee(employee_id));

create policy "assignments_update_authorized" on public.assignments
  for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' or public.manages_employee(employee_id))
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' or public.manages_employee(employee_id));

-- No delete policy.
