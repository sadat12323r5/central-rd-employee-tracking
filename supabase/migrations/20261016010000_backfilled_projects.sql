-- Story 4.7: Staff backfill a past project (work done before this system existed, or never tracked).
-- ADDITIVE only: a new table with its index, a guard function + triggers, RLS policies on the new table,
-- and one new read-only function (public.department_options). No existing table, column, constraint,
-- function or policy is altered or dropped.
--
-- * A backfilled project is a separate, employee-authored record (AD-2): assignments are untouched, and
--   the app's only writer is src/server/backfilled-project-store.ts.
-- * Owner-only writes (FR-8: "only the owner can add, edit and withdraw"): the insert and update policies
--   allow only rows whose employee is linked to auth.uid(). There is deliberately no Administrator or
--   manager write policy at all: they read these rows (select policy) but can never change them.
-- * Withdrawn entries are kept and marked (status 'withdrawn', withdrawn_at set) rather than deleted; the
--   check backfilled_projects_withdrawn_at keeps status and withdrawn_at consistent.
-- * The guard (SECURITY DEFINER, empty search_path, BEFORE INSERT OR UPDATE) makes the database the
--   authority on the lifecycle: an insert is always active with database timestamps; on update, a withdrawn
--   row is frozen, id / employee_id / created_at are locked, active -> withdrawn stamps withdrawn_at, and
--   updated_at is always the database's clock. A completion date after today (Asia/Dhaka) is refused on
--   insert and on any update that changes it, so a direct write cannot store a future "past" project; and a
--   withdrawal changes nothing but the status (the content columns must stay as they were). Refusals raise
--   check_violation (23514). It follows the assignments_guard precedent and binds the service role too.
-- * A BEFORE DELETE trigger always raises (service role included), and there is no delete policy.
-- * Department choice: a backfilled entry names a department from the list (FK, on delete restrict). Staff
--   cannot read public.departments (it holds manager_user_id and is Administrator/manager-only, 4.1/4.3),
--   so public.department_options() — SECURITY DEFINER, stable — returns only every department's id and
--   name, without widening the table's RLS. Execute is granted to authenticated only.
-- * Policies: select for the Administrator (app_metadata.role = 'admin'), a manager over the employee
--   (public.manages_employee) and the employee themselves; insert/update for the employee themselves only.

create table public.backfilled_projects (
  id              uuid primary key default gen_random_uuid(),
  employee_id     text not null references public.employees (employee_id) on delete restrict,
  department_id   uuid not null references public.departments (id) on delete restrict,
  client          text not null check (client = btrim(client) and char_length(client) between 1 and 200),
  project_name    text not null check (project_name = btrim(project_name) and char_length(project_name) between 1 and 200),
  completion_date date not null,
  outcome         text not null check (outcome = btrim(outcome) and char_length(outcome) between 1 and 2000),
  status          text not null default 'active' check (status in ('active', 'withdrawn')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  withdrawn_at    timestamptz null,
  constraint backfilled_projects_withdrawn_at check ((status = 'active') = (withdrawn_at is null))
);

-- Profiles read backfilled projects per employee.
create index backfilled_projects_employee_id_idx on public.backfilled_projects (employee_id);
-- Backs the on-delete-restrict foreign key to departments.
create index backfilled_projects_department_id_idx on public.backfilled_projects (department_id);

create or replace function public.backfilled_projects_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' or new.completion_date is distinct from old.completion_date)
     and new.completion_date > (now() at time zone 'Asia/Dhaka')::date then
    raise exception 'the completion date of a past project cannot be in the future' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    -- Always a new, active entry with the database's timestamps, whatever the caller sent.
    new.status := 'active';
    new.withdrawn_at := null;
    new.created_at := now();
    new.updated_at := new.created_at;
    return new;
  end if;

  -- UPDATE. A withdrawn entry is frozen: it never changes again and never becomes active.
  if old.status = 'withdrawn' then
    raise exception 'backfilled project % was withdrawn and can no longer be changed', old.id using errcode = '23514';
  end if;
  if new.id is distinct from old.id
     or new.employee_id is distinct from old.employee_id
     or new.created_at is distinct from old.created_at then
    raise exception 'the identifying fields of a backfilled project cannot be changed' using errcode = '23514';
  end if;
  if new.status = 'withdrawn' then
    -- active -> withdrawn: only the status changes; the withdrawal time is the database's.
    if new.department_id is distinct from old.department_id
       or new.client is distinct from old.client
       or new.project_name is distinct from old.project_name
       or new.completion_date is distinct from old.completion_date
       or new.outcome is distinct from old.outcome then
      raise exception 'withdrawing a past project cannot change its values' using errcode = '23514';
    end if;
    new.withdrawn_at := now();
  else
    new.withdrawn_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger backfilled_projects_guard
  before insert or update on public.backfilled_projects
  for each row execute function public.backfilled_projects_guard();

create or replace function public.backfilled_projects_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'backfilled projects are never deleted' using errcode = '23514';
end;
$$;

-- Binds every role, the service role included.
create trigger backfilled_projects_no_delete
  before delete on public.backfilled_projects
  for each row execute function public.backfilled_projects_no_delete();

-- Trigger functions only: nobody calls them directly.
revoke execute on function public.backfilled_projects_guard() from public, anon, authenticated;
revoke execute on function public.backfilled_projects_no_delete() from public, anon, authenticated;

alter table public.backfilled_projects enable row level security;

-- Read: the Administrator, a manager over the employee, and the employee themselves.
create policy "backfilled_projects_select" on public.backfilled_projects
  for select to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or public.manages_employee(employee_id)
    or exists (
      select 1 from public.employees e
      where e.employee_id = backfilled_projects.employee_id and e.auth_user_id = (select auth.uid())
    )
  );

-- Write: the employee themselves only (no Administrator or manager write policy).
create policy "backfilled_projects_insert_own" on public.backfilled_projects
  for insert to authenticated
  with check (exists (
    select 1 from public.employees e
    where e.employee_id = backfilled_projects.employee_id and e.auth_user_id = (select auth.uid())
  ));

create policy "backfilled_projects_update_own" on public.backfilled_projects
  for update to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = backfilled_projects.employee_id and e.auth_user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.employees e
    where e.employee_id = backfilled_projects.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- No delete policy.

-- The department list Staff pick from: id and name only (never manager_user_id or the hierarchy).
create function public.department_options()
  returns table (id uuid, name text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select d.id, d.name from public.departments d order by d.name, d.id;
$$;

-- Signed-in users only. anon is revoked explicitly too, since Supabase's default privileges grant it
-- execute on new public functions.
revoke execute on function public.department_options() from public, anon;
grant execute on function public.department_options() to authenticated;
