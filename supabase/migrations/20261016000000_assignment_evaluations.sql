-- Story 4.6: a manager evaluates a closed assignment; the employee sees it.
-- ADDITIVE only: a new table with its indexes, a guard function + triggers, RLS policies on the new table,
-- and one NEW select policy on the existing public.assignments table (assignments_select_department_managed,
-- see "Transfer read path" below). No existing table, column, constraint, function or policy is altered.
--
-- * An evaluation is a separate record (AD-2): the assignments table gains no evaluation-shaped field and
--   this migration never writes it. One evaluation per closed assignment (unique index
--   assignment_evaluations_one_per_assignment); a second record is refused, so amending is the only path.
-- * employee_id and department_id are never the caller's choice: on insert the guard copies them from the
--   assignment (SECURITY DEFINER, so the caller need not be able to read the assignment row) and refuses an
--   assignment that does not exist or is not closed. Authority follows the assignment's own department
--   (AD-4: its manager chain plus every Administrator), not the employee's current department, so after a
--   transfer (4.8) the manager who ran the work can still evaluate it.
-- * Authorship: created_by is the first writer and never changes; authored_by and updated_at are the latest
--   writer (an amendment by another manager is recorded without a history table). Both come from the
--   signed-in user's JWT (auth.uid()); only a service-role write (no JWT) keeps what it sent.
-- * Authorship snapshot: each write also records the writer's display name (the employees row linked to
--   auth.uid(), null when none) and role ('admin' from the JWT's app_metadata, else 'manager'), so the
--   label shown never depends on the viewer or on later manager changes. created_by_name/_role are locked
--   on update like created_by. A service-role write keeps what it sent (role defaults to 'admin').
-- * Transfer read path: a new select policy on assignments (assignments_select_department_managed,
--   manages_department(department_id)) lets the assignment's own department manager read it after the
--   employee moved (4.8), so the store can still find the assignment to evaluate. It is a new, additive
--   policy; nothing existing changes. Until Story 4.8 adds a way to transfer an employee, this
--   post-transfer path is reachable only through the database and the store (no app flow moves anyone).
-- * Own record: nobody writes the evaluation of their own assignment (Story 4.10: one's own record keeps
--   the Staff rules), so the write policies exclude rows whose employee is linked to auth.uid(), the
--   Administrator included.
-- * Why a trigger and not column grants: it follows the assignments_guard precedent; it is purely additive;
--   it binds the service role too; and it can copy values from the assignment row.
-- * The guard raises check_violation (23514) for any refused change. A BEFORE DELETE trigger always raises
--   (service role included), and there is no delete policy.
-- * Policies: the Administrator (app_metadata.role = 'admin') and a manager over the assignment's
--   department (public.manages_department) read, insert and update; a manager over the employee's current
--   department (public.manages_employee) also reads; the employee reads their own rows
--   (employees.auth_user_id = auth.uid()). Staff never write.
-- The app's only writer is src/server/assignment-evaluations-store.ts.

create table public.assignment_evaluations (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid not null references public.assignments (id) on delete restrict,
  employee_id     text not null references public.employees (employee_id) on delete restrict,
  department_id   uuid not null references public.departments (id) on delete restrict,
  evaluation      text not null check (evaluation = btrim(evaluation) and char_length(evaluation) between 1 and 4000),
  client_feedback text not null default '' check (char_length(client_feedback) <= 2000),
  created_by      uuid not null,
  created_by_name text null,
  created_by_role text not null check (created_by_role in ('admin', 'manager')),
  created_at      timestamptz not null default now(),
  authored_by     uuid not null,
  authored_by_name text null,
  authored_by_role text not null check (authored_by_role in ('admin', 'manager')),
  updated_at      timestamptz not null default now()
);

-- One evaluation per assignment.
create unique index assignment_evaluations_one_per_assignment on public.assignment_evaluations (assignment_id);
-- Profiles read evaluations per employee.
create index assignment_evaluations_employee_id_idx on public.assignment_evaluations (employee_id);
-- Manager reads and the write policies filter by the assignment's department.
create index assignment_evaluations_department_id_idx on public.assignment_evaluations (department_id);

create or replace function public.assignment_evaluations_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee   text;
  v_department uuid;
  v_status     text;
  v_uid        uuid := auth.uid();
  v_name       text;
  v_role       text;
begin
  if v_uid is not null then
    select e.name into v_name from public.employees e where e.auth_user_id = v_uid;
    v_role := case when (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' then 'admin' else 'manager' end;
  end if;

  if tg_op = 'INSERT' then
    select a.employee_id, a.department_id, a.status into v_employee, v_department, v_status
      from public.assignments a where a.id = new.assignment_id;
    if v_status is distinct from 'closed' then
      raise exception 'assignment % is not closed', new.assignment_id using errcode = '23514';
    end if;
    -- The assignment's subject and department, whatever the caller sent.
    new.employee_id := v_employee;
    new.department_id := v_department;
    new.created_by := coalesce(v_uid, new.created_by);
    if v_uid is not null then
      new.created_by_name := v_name;
      new.created_by_role := v_role;
    else
      new.created_by_role := coalesce(new.created_by_role, 'admin');
    end if;
    new.authored_by := new.created_by;
    new.authored_by_name := new.created_by_name;
    new.authored_by_role := new.created_by_role;
    new.created_at := now();
    new.updated_at := new.created_at;
    return new;
  end if;

  -- UPDATE: only the texts change; the latest writer and time are the database's.
  if new.id is distinct from old.id
     or new.assignment_id is distinct from old.assignment_id
     or new.employee_id is distinct from old.employee_id
     or new.department_id is distinct from old.department_id
     or new.created_by is distinct from old.created_by
     or new.created_by_name is distinct from old.created_by_name
     or new.created_by_role is distinct from old.created_by_role
     or new.created_at is distinct from old.created_at then
    raise exception 'the identifying fields of an evaluation cannot be changed' using errcode = '23514';
  end if;
  new.authored_by := coalesce(v_uid, new.authored_by);
  if v_uid is not null then
    new.authored_by_name := v_name;
    new.authored_by_role := v_role;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger assignment_evaluations_guard
  before insert or update on public.assignment_evaluations
  for each row execute function public.assignment_evaluations_guard();

create or replace function public.assignment_evaluations_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'assignment evaluations are never deleted' using errcode = '23514';
end;
$$;

-- Binds every role, the service role included.
create trigger assignment_evaluations_no_delete
  before delete on public.assignment_evaluations
  for each row execute function public.assignment_evaluations_no_delete();

-- Trigger functions only: nobody calls them directly.
revoke execute on function public.assignment_evaluations_guard() from public, anon, authenticated;
revoke execute on function public.assignment_evaluations_no_delete() from public, anon, authenticated;

alter table public.assignment_evaluations enable row level security;

-- Read: the Administrator, a manager over the assignment's department or over the employee, and the
-- employee themselves (read-only).
create policy "assignment_evaluations_select" on public.assignment_evaluations
  for select to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or public.manages_department(department_id)
    or public.manages_employee(employee_id)
    or exists (
      select 1 from public.employees e
      where e.employee_id = assignment_evaluations.employee_id and e.auth_user_id = (select auth.uid())
    )
  );

-- Write: the Administrator, or a manager over the assignment's department; never on one's own assignment.
create policy "assignment_evaluations_insert_authorized" on public.assignment_evaluations
  for insert to authenticated
  with check (
    ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' or public.manages_department(department_id))
    and not exists (
      select 1 from public.employees e
      where e.employee_id = assignment_evaluations.employee_id and e.auth_user_id = (select auth.uid())
    )
  );

create policy "assignment_evaluations_update_authorized" on public.assignment_evaluations
  for update to authenticated
  using (
    ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' or public.manages_department(department_id))
    and not exists (
      select 1 from public.employees e
      where e.employee_id = assignment_evaluations.employee_id and e.auth_user_id = (select auth.uid())
    )
  )
  with check (
    ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' or public.manages_department(department_id))
    and not exists (
      select 1 from public.employees e
      where e.employee_id = assignment_evaluations.employee_id and e.auth_user_id = (select auth.uid())
    )
  );

-- No delete policy.

-- Transfer read path: the assignment's own department manager (and ancestors) reads it even after the
-- employee moved to another department, so its evaluation can still be written and amended.
create policy "assignments_select_department_managed" on public.assignments
  for select to authenticated
  using (public.manages_department(department_id));
