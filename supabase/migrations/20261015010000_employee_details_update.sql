-- Story 7.2: edit an employee's basic details.
-- ADDITIVE only: one new function and its grants. No table, column, constraint, index, policy or existing
-- function is altered or tightened, and there is still no update policy on public.employees.
--
-- * Why a function and not an update policy: RLS cannot limit which columns an UPDATE touches, and
--   Supabase grants `authenticated` update on every column, so an update policy would let a manager
--   change department_id, archived_at or auth_user_id through the data API. This SECURITY DEFINER
--   function names only the five basic-details columns (title, team, manager, office, employment_type),
--   so an employee's department changes only through a transfer, at the database.
-- * Authority: the Administrator (JWT app_metadata.role = 'admin') for anyone; a department manager for
--   employees in their subtree (public.manages_employee, from the manager_scope migration). A caller whose
--   own employee row is archived is refused. The authority check runs before any lookup, so a non-admin
--   learns nothing about Employee IDs outside their scope.
-- * Values are trimmed with inner whitespace collapsed; each must be 1-120 characters, and the
--   employment type one of Permanent, Trainee, Intern (the values in use).
-- * Returns the employee's name for the confirmation message. Errors (SQLSTATE P0001):
--   not_authorized, invalid_input, employee_not_found.
-- The app's employees-store re-checks the same authority before calling it (defence in depth).

create function public.update_employee_details(
  p_employee_id text, p_title text, p_team text, p_manager text, p_office text, p_employment_type text
)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_title text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  v_team text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_team, ''), '\s+', ' ', 'g'));
  v_manager text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_manager, ''), '\s+', ' ', 'g'));
  v_office text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_office, ''), '\s+', ' ', 'g'));
  v_type text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_employment_type, ''), '\s+', ' ', 'g'));
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.employees e
      where e.auth_user_id = auth.uid() and e.archived_at is not null
  ) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if not (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
    or coalesce(public.manages_employee(p_employee_id), false)
  ) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if v_title = '' or pg_catalog.char_length(v_title) > 120
    or v_team = '' or pg_catalog.char_length(v_team) > 120
    or v_manager = '' or pg_catalog.char_length(v_manager) > 120
    or v_office = '' or pg_catalog.char_length(v_office) > 120
    or v_type not in ('Permanent', 'Trainee', 'Intern') then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;

  select e.name into v_name
    from public.employees e
    where e.employee_id = p_employee_id
    for update;
  if not found then
    raise exception 'employee_not_found' using errcode = 'P0001';
  end if;

  update public.employees
    set title = v_title, team = v_team, manager = v_manager, office = v_office, employment_type = v_type
    where employee_id = p_employee_id;

  return v_name;
end;
$$;

-- Signed-in users only. anon is revoked explicitly too, since Supabase's default privileges grant it
-- execute on new public functions.
revoke execute on function public.update_employee_details(text, text, text, text, text, text) from public, anon;
grant execute on function public.update_employee_details(text, text, text, text, text, text) to authenticated;

-- No update, insert or delete policies.
