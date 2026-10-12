-- Story 2.1: external interviews reported by staff (company, role, date, stage; outcome optional).
-- ADDITIVE only: a new table, its index and RLS policies. Nothing existing is altered.
-- Privacy rule: only the reporting employee and Administrator-role accounts can read an interview.
-- The policies use exactly "is this the employee (employees.auth_user_id = auth.uid()), or an
-- Administrator (app_metadata.role = 'admin')", never a department or manager lookup, so future
-- manager sessions are excluded automatically.
-- There are no update or delete policies (Story 2.2 adds the update path; nothing is ever hard-deleted).
-- Seeding (the former fixture interviews) is done by scripts/seed-employees.ts, never by this migration.

create table public.external_interviews (
  id             uuid primary key default gen_random_uuid(),
  employee_id    text not null references public.employees (employee_id) on delete restrict,
  company        text not null check (char_length(btrim(company)) >= 1 and char_length(company) <= 200),
  role           text not null check (char_length(btrim(role)) >= 1 and char_length(role) <= 200),
  stage          text not null check (char_length(btrim(stage)) >= 1 and char_length(stage) <= 200),
  interview_date date not null,
  outcome        text not null default '' check (char_length(outcome) <= 200),
  feedback       text not null default '' check (char_length(feedback) <= 2000),
  created_at     timestamptz not null default now()
);

-- Staff read their own interviews; Administrators read them per employee (profile Interviews tab).
create index external_interviews_employee_id_idx on public.external_interviews (employee_id);

alter table public.external_interviews enable row level security;

-- Administrators read every interview. Roles live in app_metadata, which only the service role can set.
create policy "external_interviews_select_admin" on public.external_interviews
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Staff read only interviews of the employee linked to their own auth identity.
create policy "external_interviews_select_own" on public.external_interviews
  for select to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = external_interviews.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- Staff add interviews only for the employee linked to their own auth identity.
-- Administrators have no write path (read-only by design).
create policy "external_interviews_insert_own" on public.external_interviews
  for insert to authenticated
  with check (exists (
    select 1 from public.employees e
    where e.employee_id = external_interviews.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- No update or delete policy.
