-- Story 7.3: employment history (role, employer, period, detail) moves from the fixture into a table.
-- ADDITIVE only: a new table, its index, guard functions + triggers and RLS policies. Nothing existing
-- (tables, columns, constraints, policies, functions or grants) is altered.
--
-- * Who may read and write an employee's history: the Administrator (JWT app_metadata.role = 'admin')
--   for anyone; the employee themselves (employees.auth_user_id = auth.uid()); a department manager for
--   employees in their subtree (public.manages_employee, from the manager_scope migration). The same
--   predicate guards select, insert and update. The app's employment-history-store re-checks the same
--   authority before every write (defence in depth).
-- * Nothing is ever hard-deleted. Removal sets removed_at once (the trigger stamps it with now(), whatever
--   the client sent); a removed row can never change again, and there is no un-remove. There is no delete
--   policy, and a BEFORE DELETE trigger refuses every delete, the service role's included.
-- * The guard trigger owns created_by (auth.uid()), created_at and updated_at, and locks id, employee_id,
--   created_by and created_at after creation, so an entry can never move to another employee.
-- * The period stays free text (the demo entries read "2022-02-06 – Present" and "2021 – 2022"), but it
--   must contain a four-digit year 1900-2099 so every entry sorts newest first.
-- Seeding (the former fixture history) is done by scripts/seed-employees.ts, never by this migration.

create table public.employment_history (
  id          uuid primary key default gen_random_uuid(),
  employee_id text not null references public.employees (employee_id) on delete restrict,
  role        text not null check (char_length(btrim(role)) between 1 and 200 and char_length(role) <= 200),
  employer    text not null check (char_length(btrim(employer)) between 1 and 200 and char_length(employer) <= 200),
  period      text not null check (
    char_length(btrim(period)) between 1 and 60 and char_length(period) <= 60
    and period ~ '(^|[^0-9])(19|20)[0-9]{2}([^0-9]|$)'
  ),
  detail      text not null default '' check (char_length(detail) <= 2000),
  created_by  uuid null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  removed_at  timestamptz null
);

-- History is read per employee (profile Employment tab, staff portal).
create index employment_history_employee_id_idx on public.employment_history (employee_id);

create or replace function public.employment_history_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- The author and the timestamps are the database's, never client-chosen; a new entry is active.
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    new.removed_at := null;
    return new;
  end if;

  -- A removed entry is immutable. (An update that changes nothing is not a change. db:seed never
  -- updates existing history rows: it inserts missing ones only.)
  if old.removed_at is not null and new is distinct from old then
    raise exception 'employment history entry % was removed and can no longer be changed', old.id
      using errcode = '23514';
  end if;
  if new.id is distinct from old.id
     or new.employee_id is distinct from old.employee_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'the employee, author and creation time of an employment history entry cannot be changed'
      using errcode = '23514';
  end if;
  -- The removal time is the database's, never a client-chosen value, and a removal keeps the entry as it
  -- was: role, employer, period and detail cannot change in the same update.
  if old.removed_at is null and new.removed_at is not null then
    if (new.role, new.employer, new.period, new.detail) is distinct from (old.role, old.employer, old.period, old.detail) then
      raise exception 'removing employment history entry % cannot also change it', old.id
        using errcode = '23514';
    end if;
    new.removed_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger employment_history_guard
  before insert or update on public.employment_history
  for each row execute function public.employment_history_guard();

create or replace function public.employment_history_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'employment history is never deleted; remove an entry instead (sets removed_at)'
    using errcode = '23514';
end;
$$;

-- Binds every role, the service role included.
create trigger employment_history_no_delete
  before delete on public.employment_history
  for each row execute function public.employment_history_no_delete();

-- TRUNCATE skips row triggers: revoke it from the API roles and refuse it for any role that still holds it.
revoke truncate on public.employment_history from anon, authenticated, service_role;
create trigger employment_history_no_truncate
  before truncate on public.employment_history
  for each statement execute function public.employment_history_no_delete();

alter table public.employment_history enable row level security;

-- One predicate for every operation: the Administrator, the employee themselves, or a manager of the
-- employee's department subtree. Roles live in app_metadata, which only the service role can set.
create policy "employment_history_select" on public.employment_history
  for select to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.employees e
      where e.employee_id = employment_history.employee_id and e.auth_user_id = (select auth.uid())
    )
    or public.manages_employee(employee_id)
  );

create policy "employment_history_insert" on public.employment_history
  for insert to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.employees e
      where e.employee_id = employment_history.employee_id and e.auth_user_id = (select auth.uid())
    )
    or public.manages_employee(employee_id)
  );

create policy "employment_history_update" on public.employment_history
  for update to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.employees e
      where e.employee_id = employment_history.employee_id and e.auth_user_id = (select auth.uid())
    )
    or public.manages_employee(employee_id)
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.employees e
      where e.employee_id = employment_history.employee_id and e.auth_user_id = (select auth.uid())
    )
    or public.manages_employee(employee_id)
  );

-- No delete policy.
