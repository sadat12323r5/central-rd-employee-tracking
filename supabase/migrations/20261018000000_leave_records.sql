-- Story 5.2: record a leave period. Leave moves into a table.
-- ADDITIVE only: a new table, its index, guard functions + triggers and RLS policies. Nothing existing
-- (tables, columns, constraints, policies, functions or grants) is altered.
--
-- * Who may read and record an employee's leave: the Administrator (JWT app_metadata.role = 'admin') for
--   anyone; the employee themselves (employees.auth_user_id = auth.uid()); a department manager for
--   employees in their subtree (public.manages_employee, from the manager_scope migration). The same
--   predicate as employment_history guards select and insert. The app's leave-store re-checks the same
--   authority before every write (defence in depth).
-- * The app counts the working days (src/domain/leave.ts, against the active holiday calendar) and assigns
--   the category; each row stores both together with the calendar version it was counted with
--   (calendar_version_id), so past counts stay explainable after a corrected calendar is loaded.
-- * There is no update or delete policy (Story 5.3 adds editing and cancelling). cancelled_at is always
--   null in 5.2; a cancelled row is ignored by the overlap check.
-- * The guard trigger owns created_by (auth.uid()) and created_at, locks id, employee_id, created_by and
--   created_at after creation, refuses any change to a cancelled row, requires the active (highest)
--   calendar version (23514 leave_calendar_changed), checks the dates fall within its supported years
--   (23514 leave_outside_calendar), recounts the working days (Monday to Friday minus that version's
--   holidays; 23514 leave_working_days_mismatch) and checks the category band for that count (23514
--   leave_category_mismatch), so a direct API insert cannot store a wrong count; and, holding a per-employee
--   transaction advisory lock, refuses a period that intersects (inclusive) another non-cancelled leave of
--   the same employee (23514 leave_overlap, detail 'YYYY-MM-DD,YYYY-MM-DD' = the existing period). The
--   store checks overlap first; the trigger is the backstop for concurrent saves.
-- * Nothing is ever hard-deleted: a BEFORE DELETE trigger refuses every delete, the service role's included.
-- Seeding: none.

create table public.leave_records (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         text not null references public.employees (employee_id) on delete restrict,
  start_date          date not null,
  end_date            date not null,
  working_days        integer not null check (working_days > 0),
  category            text not null check (category in (
    'ONE_TO_THREE', 'FOUR_TO_FOURTEEN', 'FIFTEEN_TO_THIRTY', 'THIRTY_ONE_TO_NINETY', 'NINETY_ONE_PLUS'
  )),
  calendar_version_id uuid not null references public.holiday_calendar_versions (id) on delete restrict,
  cancelled_at        timestamptz null,
  created_by          uuid null,
  created_at          timestamptz not null default now(),
  constraint leave_records_range_check check (end_date >= start_date)
);

-- Leave is read per employee, newest start first, and the overlap check scans one employee's periods.
create index leave_records_employee_start_idx on public.leave_records (employee_id, start_date);

create or replace function public.leave_records_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_start integer;
  v_end integer;
  v_days integer;
  v_existing record;
begin
  if tg_op = 'INSERT' then
    -- The author and the creation time are the database's, never client-chosen; a new period is active.
    new.created_by := auth.uid();
    new.created_at := now();
    new.cancelled_at := null;
  else
    if old.cancelled_at is not null and new is distinct from old then
      raise exception 'leave record % was cancelled and can no longer be changed', old.id
        using errcode = '23514';
    end if;
    if new.id is distinct from old.id
       or new.employee_id is distinct from old.employee_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'the employee, author and creation time of a leave record cannot be changed'
        using errcode = '23514';
    end if;
    if old.cancelled_at is null and new.cancelled_at is not null then
      -- A cancellation keeps the period as it was; its time is the database's.
      if (new.start_date, new.end_date, new.working_days, new.category, new.calendar_version_id)
         is distinct from (old.start_date, old.end_date, old.working_days, old.category, old.calendar_version_id) then
        raise exception 'cancelling leave record % cannot also change it', old.id using errcode = '23514';
      end if;
      new.cancelled_at := now();
      return new;
    end if;
  end if;

  -- A period is always counted with the active (highest) calendar version.
  if new.calendar_version_id is distinct from (
    select v.id from public.holiday_calendar_versions v order by v.version desc limit 1
  ) then
    raise exception 'leave_calendar_changed' using errcode = '23514';
  end if;

  -- The dates must fall within the supported years of the calendar version they were counted with.
  select v.supported_year_start, v.supported_year_end into v_start, v_end
    from public.holiday_calendar_versions v
    where v.id = new.calendar_version_id;
  if found and (extract(year from new.start_date)::integer not between v_start and v_end
                or extract(year from new.end_date)::integer not between v_start and v_end) then
    raise exception 'leave_outside_calendar' using errcode = '23514';
  end if;

  -- The working days and category are the database's check of the app's count (src/domain/leave.ts):
  -- Monday to Friday, minus that version's holidays; categories 1–3, 4–14, 15–30, 31–90, 91+.
  select count(*)::integer into v_days
    from generate_series(new.start_date, new.end_date, interval '1 day') as d(day)
    where extract(isodow from d.day) < 6
      and not exists (
        select 1 from public.holiday_calendar_dates h
        where h.version_id = new.calendar_version_id and h.holiday_date = d.day::date
      );
  if new.working_days is distinct from v_days then
    raise exception 'leave_working_days_mismatch' using errcode = '23514';
  end if;
  if new.category is distinct from (case
      when v_days <= 3 then 'ONE_TO_THREE'
      when v_days <= 14 then 'FOUR_TO_FOURTEEN'
      when v_days <= 30 then 'FIFTEEN_TO_THIRTY'
      when v_days <= 90 then 'THIRTY_ONE_TO_NINETY'
      else 'NINETY_ONE_PLUS' end) then
    raise exception 'leave_category_mismatch' using errcode = '23514';
  end if;

  if new.cancelled_at is null then
    -- One writer per employee at a time (released at the end of the transaction), so two concurrent
    -- saves cannot both pass the overlap check.
    perform pg_advisory_xact_lock(hashtextextended('leave_records:' || new.employee_id, 0));
    select l.start_date, l.end_date into v_existing
      from public.leave_records l
      where l.employee_id = new.employee_id
        and l.cancelled_at is null
        and l.id is distinct from new.id
        and l.start_date <= new.end_date
        and l.end_date >= new.start_date
      order by l.start_date
      limit 1;
    if found then
      raise exception 'leave_overlap'
        using errcode = '23514', detail = v_existing.start_date::text || ',' || v_existing.end_date::text;
    end if;
  end if;
  return new;
end;
$$;

create trigger leave_records_guard
  before insert or update on public.leave_records
  for each row execute function public.leave_records_guard();

create or replace function public.leave_records_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'leave records are never deleted; cancel a period instead (sets cancelled_at)'
    using errcode = '23514';
end;
$$;

-- Binds every role, the service role included.
create trigger leave_records_no_delete
  before delete on public.leave_records
  for each row execute function public.leave_records_no_delete();

-- TRUNCATE skips row triggers: revoke it from the API roles and refuse it for any role that still holds it.
revoke truncate on public.leave_records from anon, authenticated, service_role;
create trigger leave_records_no_truncate
  before truncate on public.leave_records
  for each statement execute function public.leave_records_no_delete();

alter table public.leave_records enable row level security;

-- One predicate for select and insert: the Administrator, the employee themselves, or a manager of the
-- employee's department subtree. Roles live in app_metadata, which only the service role can set.
create policy "leave_records_select" on public.leave_records
  for select to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.employees e
      where e.employee_id = leave_records.employee_id and e.auth_user_id = (select auth.uid())
    )
    or public.manages_employee(employee_id)
  );

create policy "leave_records_insert" on public.leave_records
  for insert to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.employees e
      where e.employee_id = leave_records.employee_id and e.auth_user_id = (select auth.uid())
    )
    or public.manages_employee(employee_id)
  );

-- No update or delete policy (Story 5.3 adds editing and cancelling).
