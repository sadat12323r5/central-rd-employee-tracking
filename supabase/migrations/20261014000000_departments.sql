-- Story 4.1: the Administrator manages the department list (create, rename, set parent).
-- ADDITIVE only: a new table with its indexes, a cycle-guard function + trigger and RLS policies, plus a
-- new nullable foreign-key column (and index) on employees. No existing column, constraint or policy is
-- altered. employees.department_id stays nullable here: NOT NULL is deferred (a tightening) until
-- Epic 7 adds employee creation.
--
-- * Names are trimmed with inner whitespace collapsed by the app; the check below rejects leading or
--   trailing whitespace and anything outside 1..100 characters. Uniqueness is case-insensitive
--   (unique index on lower(name)).
-- * A department may not be its own parent or ancestor. The app's departments-store checks first; the
--   trigger below is the backstop, serialised with a transaction-level advisory lock so two concurrent
--   re-parents cannot together form a cycle. It raises check_violation with the message
--   'department_cycle'.
-- * There is no delete path: no DELETE policy, and both foreign keys are ON DELETE RESTRICT.
-- Seeding (L&D and Central R&D, and the fixture employees' department) is done by
-- scripts/seed-employees.ts, never by this migration.

create table public.departments (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  parent_department_id uuid null references public.departments (id) on delete restrict,
  created_at           timestamptz not null default now(),
  constraint departments_not_own_parent check (parent_department_id is null or parent_department_id <> id)
);

create unique index departments_name_lower_key on public.departments (lower(name));
create index departments_parent_department_id_idx on public.departments (parent_department_id);

create or replace function public.departments_prevent_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_current uuid := new.parent_department_id;
  v_seen uuid[] := array[new.id];
begin
  if new.parent_department_id is null then
    return new;
  end if;
  -- One hierarchy change at a time: concurrent re-parents queue here until the first commits.
  perform pg_advisory_xact_lock(hashtext('public.departments.hierarchy'));
  while v_current is not null loop
    if v_current = any (v_seen) then
      raise exception 'department_cycle' using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_current;
    select d.parent_department_id into v_current from public.departments d where d.id = v_current;
  end loop;
  return new;
end;
$$;

create trigger departments_prevent_cycle
  before insert or update of parent_department_id on public.departments
  for each row execute function public.departments_prevent_cycle();

alter table public.departments enable row level security;

-- Administrators only. Roles live in app_metadata, which only the service role can set.
create policy "departments_select_admin" on public.departments
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "departments_insert_admin" on public.departments
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "departments_update_admin" on public.departments
  for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- No delete policy.

-- Each employee belongs to at most one department (the seed puts every fixture employee in Central R&D).
alter table public.employees add column department_id uuid null references public.departments (id) on delete restrict;
create index employees_department_id_idx on public.employees (department_id);
