-- Story 4.8: an Administrator, or a manager with authority over both departments, transfers an employee
-- from one department to another in one step, with one audit row.
-- Classification: DESTRUCTIVE, because the existing check constraint audit_events_action_check is dropped
-- and replaced (precedent: 20261013000000_activity_export_audit.sql). The replacement only widens it (it
-- also allows 'transfer'), so every existing row still satisfies it. Everything else is additive:
--
-- * audit_events.from_department_id / to_department_id: nullable uuid columns, deliberately without a
--   foreign key, because audit rows are append-only and must outlive any department. from_department_id is
--   null when the employee had no department before the transfer.
-- * audit_events_transfer_check: a transfer row always records its destination; every other row records
--   neither department. Existing rows (archive, restore, export_activity) have both null, so they pass.
--   audit_events_period_check still holds too: transfer rows have null periods.
-- * public.transfer_employee(employee, destination) is called through the actor's own JWT (the app's user
--   client, never the service role) by both the Administrator and managers. The actor is always auth.uid(),
--   never a parameter. It is SECURITY DEFINER because there is no update policy on employees and audit_events
--   has no policies at all; it exposes only the employee's name and the error codes below.
-- * The Administrator test is (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', the same test the
--   departments policies use. Anyone else needs authority (AD-4) over both ends: the source through
--   public.manages_employee (an employee with no department passes only for the Administrator) and the
--   destination through public.manages_department (Story 4.3 helpers).
-- * The employee row is locked FOR UPDATE, so the checks, the update and the audit insert see one stable
--   row. Assignment inserts take a key-share lock on the employee through their foreign key, so an
--   assignment being opened concurrently waits for (or is seen by) the open-assignment check.
-- * A caller whose own employee row is archived is not_authorized: their JWT may still be valid until it
--   expires, and a direct rpc call skips the app's per-request archive check (as in Story 4.9).
-- * Nothing else changes: past assignments keep their recorded department_id, and training is keyed by
--   employee, so it follows the employee unchanged.
-- * PostgREST runs one rpc() call in one transaction, so the department change and its audit_events row
--   commit or fail together.
-- Errors (SQLSTATE P0001), checked in this order: not_authorized (no actor or archived caller),
-- employee_not_found, department_not_found, not_authorized (no authority over the source or the
-- destination), same_department, open_assignment.

alter table public.audit_events
  add column from_department_id uuid,
  add column to_department_id uuid;

alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events
  add constraint audit_events_action_check check (action in ('archive', 'restore', 'export_activity', 'transfer'));

alter table public.audit_events
  add constraint audit_events_transfer_check check (
    (action = 'transfer' and to_department_id is not null)
    or (action <> 'transfer' and from_department_id is null and to_department_id is null)
  );

create function public.transfer_employee(p_employee_id text, p_to_department_id uuid)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  v_name text;
  v_from uuid;
begin
  if v_actor is null then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  -- An archived caller has no authority, even while their JWT is still valid.
  if exists (select 1 from public.employees ce where ce.auth_user_id = v_actor and ce.archived_at is not null) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  select e.name, e.department_id into v_name, v_from
    from public.employees e
    where e.employee_id = p_employee_id
    for update;
  if not found then
    raise exception 'employee_not_found' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.departments d where d.id = p_to_department_id) then
    raise exception 'department_not_found' using errcode = 'P0001';
  end if;

  -- Authority over both ends (AD-4). Same error whichever end fails, or when the caller manages nothing.
  if not v_is_admin then
    if v_from is null
       or not public.manages_employee(p_employee_id)
       or not public.manages_department(p_to_department_id) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
  end if;

  if v_from = p_to_department_id then
    raise exception 'same_department' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.assignments a where a.employee_id = p_employee_id and a.status = 'open') then
    raise exception 'open_assignment' using errcode = 'P0001';
  end if;

  update public.employees
    set department_id = p_to_department_id
    where employee_id = p_employee_id;

  insert into public.audit_events (actor, target, action, from_department_id, to_department_id)
    values (v_actor, p_employee_id, 'transfer', v_from, p_to_department_id);

  return v_name;
end;
$$;

-- Signed-in users only. anon is revoked explicitly too, since Supabase's default privileges grant it
-- execute on new public functions. A plain Staff caller gets not_authorized from the function itself.
revoke execute on function public.transfer_employee(text, uuid) from public, anon;
grant execute on function public.transfer_employee(text, uuid) to authenticated;
