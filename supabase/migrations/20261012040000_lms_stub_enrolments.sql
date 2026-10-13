-- Story 3.2: stub data for the LMS adapter (src/server/lms-client.ts). The real BrainStation LMS
-- integration is not available yet, so the adapter's stub reads enrolments from this table instead.
-- ADDITIVE only: a new table, its checks, index and RLS policies. Nothing existing is altered.
-- `npm run db:seed` fills it (insert-only) from the fixture's in-progress training; migrations never
-- seed data. `synced_at` is when the LMS last reported the row: the adapter marks data older than its
-- staleness threshold as stale.
-- There is deliberately no department column: training comes from L&D and stays with the employee.
-- Privacy rule: only the employee and Administrator-role accounts can read a row, with exactly the
-- predicates `training_history` uses (employees.auth_user_id = auth.uid(), or app_metadata.role =
-- 'admin'), never a department or manager lookup. There are no insert, update or delete policies:
-- only scripts/seed-employees.ts writes rows (with the service role).

create table public.lms_stub_enrolments (
  id           uuid primary key default gen_random_uuid(),
  employee_id  text not null references public.employees (employee_id) on delete restrict,
  programme    text not null check (char_length(btrim(programme)) >= 1 and char_length(programme) <= 200),
  provider     text not null check (char_length(btrim(provider)) >= 1 and char_length(provider) <= 200),
  status       text not null check (status in ('in_progress', 'completed')),
  progress     integer not null check (progress between 0 and 100),
  target_date  date null,
  completed_on date null,
  result       text not null default '' check (char_length(result) <= 200),
  synced_at    timestamptz not null default now(),
  -- In progress: below 100% with a target date. Completed: has a completion date.
  constraint lms_stub_enrolments_status_fields check (
    (status = 'in_progress' and progress < 100 and target_date is not null)
    or (status = 'completed' and completed_on is not null)
  )
);

-- The adapter reads one employee's enrolments per call.
create index lms_stub_enrolments_employee_id_idx on public.lms_stub_enrolments (employee_id);

alter table public.lms_stub_enrolments enable row level security;

-- Administrators read every row. Roles live in app_metadata, which only the service role can set.
create policy "lms_stub_enrolments_select_admin" on public.lms_stub_enrolments
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Staff read only rows of the employee linked to their own auth identity.
create policy "lms_stub_enrolments_select_own" on public.lms_stub_enrolments
  for select to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = lms_stub_enrolments.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- No insert, update or delete policy.
