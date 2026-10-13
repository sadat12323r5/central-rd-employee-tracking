-- Story 1.5: staff attendance (clock in / clock out and the daily log) persisted in Supabase.
-- ADDITIVE only: a new table, its indexes and RLS policies. Nothing existing is altered.
-- One entry per employee per Dhaka working day; there is no delete policy (no hard deletes).

create table public.attendance_entries (
  id            uuid primary key,
  employee_id   text not null references public.employees (employee_id) on delete restrict,
  work_date     date not null,
  clock_in      timestamptz not null,
  clock_out     timestamptz,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  work_mode     text not null check (work_mode in ('Office', 'Remote', 'Client site')),
  log           jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint attendance_entries_employee_day_key unique (employee_id, work_date),
  constraint attendance_entries_clock_order check (clock_out is null or clock_out >= clock_in)
);

-- Newest-first listing for Administrators (staff reads use the unique (employee_id, work_date) index).
create index attendance_entries_work_date_idx on public.attendance_entries (work_date desc, clock_in desc);

alter table public.attendance_entries enable row level security;

-- Administrators read every entry. Roles live in app_metadata, which only the service role can set.
create policy "attendance_select_admin" on public.attendance_entries
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Staff read, create and change only entries of the employee linked to their own auth identity
-- (employees.auth_user_id, the single source of truth for "which employee is this user").
create policy "attendance_select_own" on public.attendance_entries
  for select to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = attendance_entries.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- Writes are limited to today's entry in Dhaka time. Staff can reach PostgREST directly with their JWT and
-- the public anon key, so without this they could backdate entries or rewrite any past day; the app only
-- ever creates or changes today's Dhaka entry (todaysEntry / clockIn in src/domain/timesheet.ts).
create policy "attendance_insert_own" on public.attendance_entries
  for insert to authenticated
  with check (exists (
    select 1 from public.employees e
    where e.employee_id = attendance_entries.employee_id and e.auth_user_id = (select auth.uid())
  ) and work_date = (now() at time zone 'Asia/Dhaka')::date);

create policy "attendance_update_own" on public.attendance_entries
  for update to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = attendance_entries.employee_id and e.auth_user_id = (select auth.uid())
  ) and work_date = (now() at time zone 'Asia/Dhaka')::date)
  with check (exists (
    select 1 from public.employees e
    where e.employee_id = attendance_entries.employee_id and e.auth_user_id = (select auth.uid())
  ) and work_date = (now() at time zone 'Asia/Dhaka')::date);

-- No delete policy: attendance history is never hard-deleted by a signed-in user.
