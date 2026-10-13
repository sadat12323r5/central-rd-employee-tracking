-- Story 3.1: completed-training history (programme, provider, result, completion date).
-- ADDITIVE only: a new table, its index and RLS policies. Nothing existing is altered.
-- Holds completed entries only; in-progress enrolments are not stored here (Story 3.2 serves them
-- from the LMS adapter). There is deliberately no department column: training comes from L&D and
-- stays with the employee after a transfer.
-- Privacy rule: only the employee and Administrator-role accounts can read an entry. The policies use
-- exactly "is this the employee (employees.auth_user_id = auth.uid()), or an Administrator
-- (app_metadata.role = 'admin')", never a department or manager lookup.
-- There are no insert, update or delete policies: creating or editing training outside the LMS is
-- deferred, and only scripts/seed-employees.ts writes rows (with the service role). Seeding is never
-- done by this migration.

create table public.training_history (
  id           uuid primary key default gen_random_uuid(),
  employee_id  text not null references public.employees (employee_id) on delete restrict,
  programme    text not null check (char_length(btrim(programme)) >= 1 and char_length(programme) <= 200),
  provider     text not null check (char_length(btrim(provider)) >= 1 and char_length(provider) <= 200),
  result       text not null check (char_length(btrim(result)) >= 1 and char_length(result) <= 200),
  completed_on date not null,
  created_at   timestamptz not null default now()
);

-- Staff read their own history; Administrators read it per employee (profile Training tab).
create index training_history_employee_id_idx on public.training_history (employee_id);

alter table public.training_history enable row level security;

-- Administrators read every entry. Roles live in app_metadata, which only the service role can set.
create policy "training_history_select_admin" on public.training_history
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Staff read only entries of the employee linked to their own auth identity.
create policy "training_history_select_own" on public.training_history
  for select to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = training_history.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- No insert, update or delete policy.
