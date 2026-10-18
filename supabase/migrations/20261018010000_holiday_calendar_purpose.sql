-- Stories 5.1 / 5.2 fix: test calendars never become the live site's active calendar.
-- DESTRUCTIVE: redefines two existing functions (public.load_holiday_calendar, whose signature gains a
-- parameter, so the old six-argument signature is dropped and recreated; and public.leave_records_guard,
-- replaced in place). The new column holiday_calendar_versions.purpose is ADDITIVE (existing rows become
-- 'live'). No table, row, policy, trigger binding or other function is altered or removed.
--
-- Why: the active calendar was "the highest version in the whole database", and the live RLS tests and the
-- Playwright e2e load their own throwaway calendars into the one shared Supabase project, so a test
-- calendar silently became the live site's active calendar (and a leave save raced against it failed with
-- leave_calendar_changed).
--
-- * Every version now carries a purpose: 'live' (the default; what the app's Administrator load always
--   writes) or 'test' (throwaway calendars loaded by tests). The ACTIVE calendar is the highest version
--   WHERE purpose = 'live'; a 'test' version is never active, whatever its version number.
-- * load_holiday_calendar gains p_purpose text default 'live' (only 'live' or 'test'; anything else is
--   23514 holiday_calendar_purpose_invalid). Its other checks, its SECURITY INVOKER / RLS behaviour, the
--   insert-policy setting and its grants (authenticated and service_role; never public or anon) are as
--   in 20261017000000_holiday_calendars.sql.
-- * leave_records_guard requires the active (highest LIVE) version (23514 leave_calendar_changed); every
--   other rule of 20261018000000_leave_records.sql is unchanged.
-- * Unchanged (Story 5.1): Asia/Dhaka only, the supported-years checks, append-only versions and dates
--   (the BEFORE UPDATE guards also make purpose immutable), dates only in the creating transaction, the
--   RLS policies and the revoked update/delete/truncate grants.

alter table public.holiday_calendar_versions
  add column purpose text not null default 'live'
    constraint holiday_calendar_versions_purpose_check check (purpose in ('live', 'test'));

drop function public.load_holiday_calendar(text, text, integer, integer, text, jsonb);

-- Loads one complete calendar as a new version, atomically (PostgREST runs one rpc() call in one
-- transaction). p_holidays is a JSON array of {"date": "YYYY-MM-DD", "name": text, "kind": text}.
-- p_purpose: 'live' (default; becomes the active calendar) or 'test' (never active).
-- Errors: 42501 (caller is neither an Administrator nor the service role), 23514 check_violation
-- (an invalid purpose, no holidays, more than 1000, a date outside the supported years, or any table
-- check), 23505 (a duplicate date).
create function public.load_holiday_calendar(
  p_jurisdiction text,
  p_timezone text,
  p_year_start integer,
  p_year_end integer,
  p_source text,
  p_holidays jsonb,
  p_purpose text default 'live'
)
  returns public.holiday_calendar_versions
  language plpgsql
  security invoker
  set search_path = ''
as $$
declare
  v_version public.holiday_calendar_versions;
begin
  if current_user <> 'service_role'
     and coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false) is not true then
    raise exception 'Only an Administrator can load the holiday calendar.' using errcode = '42501';
  end if;
  -- Opens the insert policies for this transaction only (is_local = true).
  perform set_config('app.holiday_calendar_loading', 'on', true);

  if p_purpose is null or p_purpose not in ('live', 'test') then
    raise exception 'holiday_calendar_purpose_invalid' using errcode = 'check_violation';
  end if;

  if p_holidays is null or jsonb_typeof(p_holidays) <> 'array' or jsonb_array_length(p_holidays) = 0 then
    raise exception 'holiday_calendar_empty' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(p_holidays) > 1000 then
    raise exception 'holiday_calendar_too_many_rows' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_holidays) as h(date date, name text, kind text)
    where h.date is null or extract(year from h.date)::integer not between p_year_start and p_year_end
  ) then
    raise exception 'holiday_calendar_date_outside_years' using errcode = 'check_violation';
  end if;

  insert into public.holiday_calendar_versions (jurisdiction, timezone, supported_year_start, supported_year_end, source, purpose)
    values (p_jurisdiction, p_timezone, p_year_start, p_year_end, p_source, p_purpose)
    returning * into v_version;

  insert into public.holiday_calendar_dates (version_id, holiday_date, name, kind)
    select v_version.id, h.date, h.name, h.kind
    from jsonb_to_recordset(p_holidays) as h(date date, name text, kind text);

  return v_version;
end;
$$;

-- Signed-in users and the service role only. anon is revoked explicitly too, since Supabase's default
-- privileges grant it execute on new public functions. A non-Administrator gets 42501 from the function.
revoke execute on function public.load_holiday_calendar(text, text, integer, integer, text, jsonb, text) from public, anon;
grant execute on function public.load_holiday_calendar(text, text, integer, integer, text, jsonb, text) to authenticated, service_role;

-- As in 20261018000000_leave_records.sql, except that the active calendar is the highest LIVE version.
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

  -- A period is always counted with the active calendar: the highest LIVE version (a test calendar never is).
  if new.calendar_version_id is distinct from (
    select v.id from public.holiday_calendar_versions v where v.purpose = 'live' order by v.version desc limit 1
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
