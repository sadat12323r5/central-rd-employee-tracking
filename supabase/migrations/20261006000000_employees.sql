-- Story 1.1: employee basic details, with database-enforced uniqueness and role-scoped RLS.
-- Nested profile data (skills, history, training, ...) stays in the fixture behind employees-store.
-- Seeding is done by scripts/seed-employees.ts, never by this migration.

create table public.employees (
  employee_id     text primary key check (employee_id ~ '^BS-\d{4}$'),
  name            text not null,
  title           text not null,
  team            text not null,
  employment_type text not null,
  email           text not null unique,
  joined_on       date not null,
  manager         text not null,
  office          text not null,
  status          text not null check (status in ('On project', 'In training', 'Available')),
  initials        text not null,
  avatar_color    text not null,
  summary         text not null,
  auth_user_id    uuid unique references auth.users (id) on delete set null,
  created_at      timestamptz not null default now()
);

alter table public.employees enable row level security;

-- Administrators read every employee. Roles live in app_metadata, which only the service role can set.
create policy "employees_select_admin" on public.employees
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Staff read only the employee row linked to their own auth identity.
create policy "employees_select_own" on public.employees
  for select to authenticated
  using (auth_user_id = auth.uid());

-- No insert, update or delete policies: writes are service-role only until Epic 7.
