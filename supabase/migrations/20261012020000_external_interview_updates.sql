-- Story 2.2: staff update or withdraw their own external interviews.
-- ADDITIVE only: a new nullable column, a guard function + trigger and one new UPDATE policy.
-- The 2.1 table, its select/insert policies and existing grants are not altered.
--
-- * Only stage, outcome and feedback stay editable; company, role, date (and id, employee, created_at)
--   are locked after creation. The lock is a trigger rather than a column REVOKE so it is additive and
--   also binds the service role.
-- * Withdrawal sets withdrawn_at once (the trigger stamps it with now(), whatever the client sent). A withdrawn row can never change again. There is no DELETE policy
--   (nothing is ever hard-deleted) and no un-withdraw.
-- * The UPDATE policy uses exactly the own-employee predicate (employees.auth_user_id = auth.uid()).
--   Administrators get no update policy: they stay read-only (Administrator editing is deferred to Epic 7).

alter table public.external_interviews add column withdrawn_at timestamptz null;

create or replace function public.external_interviews_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A withdrawn entry is immutable. (An update that changes nothing is not a change. db:seed never
  -- updates existing interview rows: it inserts missing ones only.)
  if old.withdrawn_at is not null and new is distinct from old then
    raise exception 'external interview % is withdrawn and can no longer be changed', old.id
      using errcode = '23514';
  end if;
  if new.id is distinct from old.id
     or new.employee_id is distinct from old.employee_id
     or new.company is distinct from old.company
     or new.role is distinct from old.role
     or new.interview_date is distinct from old.interview_date
     or new.created_at is distinct from old.created_at then
    raise exception 'company, role and date of an external interview cannot be changed'
      using errcode = '23514';
  end if;
  -- The withdrawal time is the database's, never a client-chosen value.
  if old.withdrawn_at is null and new.withdrawn_at is not null then
    new.withdrawn_at := now();
  end if;
  return new;
end;
$$;

create trigger external_interviews_guard
  before update on public.external_interviews
  for each row execute function public.external_interviews_guard();

-- Staff update only interviews of the employee linked to their own auth identity.
create policy "external_interviews_update_own" on public.external_interviews
  for update to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = external_interviews.employee_id and e.auth_user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.employees e
    where e.employee_id = external_interviews.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- No delete policy.
