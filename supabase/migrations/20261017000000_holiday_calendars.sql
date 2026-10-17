-- Story 5.1: the Administrator loads the approved holiday calendar, stored as immutable versions.
-- ADDITIVE only: two new tables, their guard functions + triggers, RLS policies and one RPC function.
-- Nothing existing (tables, columns, constraints, policies, functions or grants) is altered.
--
-- * A version is a complete calendar: a jurisdiction, the org timezone (always Asia/Dhaka), a contiguous
--   range of supported years and every holiday date in those years. The active calendar is the version
--   with the highest version number. Leave (Story 5.2) will reference the version it was counted with.
-- * Versions and their dates are never changed: there is no update or delete policy, and a BEFORE UPDATE
--   trigger refuses every update, the service role's included. (Deletes stay possible for the service role
--   only, so the live tests can remove the throwaway versions they create; the app never deletes.)
-- * Dates can only be added in the transaction that created their version (loaded_at is the
--   transaction's now(), owned by the guard trigger), so a stored version can never gain dates later.
-- * The version row and its dates are written atomically by public.load_holiday_calendar, called through
--   the caller's own JWT (SECURITY INVOKER, so RLS applies). It refuses any caller that is neither an
--   Administrator (JWT app_metadata.role = 'admin') nor the service role (used by db:seed only).
-- * Every signed-in role may read the calendar (5.2 counts staff leave through the user's JWT); only an
--   Administrator may insert.
-- Seeding (the provisional docs/holiday-calendars/bangladesh-2026.csv) is done by
-- scripts/seed-employees.ts, never by this migration.

create table public.holiday_calendar_versions (
  id                   uuid primary key default gen_random_uuid(),
  version              integer generated always as identity unique,
  jurisdiction         text not null check (jurisdiction = btrim(jurisdiction) and char_length(jurisdiction) between 1 and 100),
  timezone             text not null default 'Asia/Dhaka' check (timezone = 'Asia/Dhaka'),
  supported_year_start integer not null check (supported_year_start between 1900 and 2999),
  supported_year_end   integer not null check (supported_year_end between 1900 and 2999),
  source               text not null check (char_length(btrim(source)) between 1 and 2000),
  loaded_by            uuid null default auth.uid(),
  loaded_at            timestamptz not null default now(),
  constraint holiday_calendar_versions_years_check check (supported_year_end >= supported_year_start)
);

create table public.holiday_calendar_dates (
  version_id   uuid not null references public.holiday_calendar_versions (id) on delete restrict,
  holiday_date date not null,
  name         text not null check (name = btrim(name) and char_length(name) between 1 and 200),
  kind         text not null check (kind in ('general', 'executive order', 'special')),
  primary key (version_id, holiday_date)
);

create or replace function public.holiday_calendar_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'holiday calendar versions are never changed; load a new version instead'
      using errcode = '23514';
  end if;
  -- Who loaded it and when are the database's, never client-chosen.
  new.loaded_by := auth.uid();
  new.loaded_at := now();
  return new;
end;
$$;

create trigger holiday_calendar_versions_guard
  before insert or update on public.holiday_calendar_versions
  for each row execute function public.holiday_calendar_versions_guard();

create or replace function public.holiday_calendar_dates_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_start integer;
  v_end integer;
  v_loaded_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    raise exception 'holiday calendar dates are never changed; load a new version instead'
      using errcode = '23514';
  end if;
  select v.supported_year_start, v.supported_year_end, v.loaded_at into v_start, v_end, v_loaded_at
    from public.holiday_calendar_versions v
    where v.id = new.version_id;
  if not found then
    return new; -- the foreign key reports it
  end if;
  -- Only the transaction that created the version may add its dates: a stored version never changes.
  if v_loaded_at <> now() then
    raise exception 'holiday_calendar_version_closed' using errcode = '23514';
  end if;
  if extract(year from new.holiday_date)::integer not between v_start and v_end then
    raise exception 'holiday_calendar_date_outside_years' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger holiday_calendar_dates_guard
  before insert or update on public.holiday_calendar_dates
  for each row execute function public.holiday_calendar_dates_guard();

-- Defence in depth below RLS: the API roles never update, delete or truncate the calendar.
revoke update, delete, truncate on public.holiday_calendar_versions from anon, authenticated;
revoke update, delete, truncate on public.holiday_calendar_dates from anon, authenticated;

alter table public.holiday_calendar_versions enable row level security;
alter table public.holiday_calendar_dates enable row level security;

-- Every signed-in role reads the calendar. Roles live in app_metadata, which only the service role can set.
create policy "holiday_calendar_versions_select" on public.holiday_calendar_versions
  for select to authenticated
  using (true);

create policy "holiday_calendar_versions_insert_admin" on public.holiday_calendar_versions
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "holiday_calendar_dates_select" on public.holiday_calendar_dates
  for select to authenticated
  using (true);

create policy "holiday_calendar_dates_insert_admin" on public.holiday_calendar_dates
  for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- No update or delete policy.

-- Loads one complete calendar as a new version, atomically (PostgREST runs one rpc() call in one
-- transaction). p_holidays is a JSON array of {"date": "YYYY-MM-DD", "name": text, "kind": text}.
-- Errors: 42501 (caller is neither an Administrator nor the service role), 23514 check_violation
-- (no holidays, a date outside the supported years, or any table check), 23505 (a duplicate date).
create function public.load_holiday_calendar(
  p_jurisdiction text,
  p_timezone text,
  p_year_start integer,
  p_year_end integer,
  p_source text,
  p_holidays jsonb
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

  if p_holidays is null or jsonb_typeof(p_holidays) <> 'array' or jsonb_array_length(p_holidays) = 0 then
    raise exception 'holiday_calendar_empty' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_holidays) as h(date date, name text, kind text)
    where h.date is null or extract(year from h.date)::integer not between p_year_start and p_year_end
  ) then
    raise exception 'holiday_calendar_date_outside_years' using errcode = 'check_violation';
  end if;

  insert into public.holiday_calendar_versions (jurisdiction, timezone, supported_year_start, supported_year_end, source)
    values (p_jurisdiction, p_timezone, p_year_start, p_year_end, p_source)
    returning * into v_version;

  insert into public.holiday_calendar_dates (version_id, holiday_date, name, kind)
    select v_version.id, h.date, h.name, h.kind
    from jsonb_to_recordset(p_holidays) as h(date date, name text, kind text);

  return v_version;
end;
$$;

-- Signed-in users and the service role only. anon is revoked explicitly too, since Supabase's default
-- privileges grant it execute on new public functions. A non-Administrator gets 42501 from the function.
revoke execute on function public.load_holiday_calendar(text, text, integer, integer, text, jsonb) from public, anon;
grant execute on function public.load_holiday_calendar(text, text, integer, integer, text, jsonb) to authenticated, service_role;
