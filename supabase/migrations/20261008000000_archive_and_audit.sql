-- Story 1.4: archive and restore an employee account, with an append-only audit record.
-- Additive only: one nullable column on employees, one new table, one function. Existing columns,
-- constraints and RLS policies are unchanged. Archiving never deletes the employee or the auth user.

-- Null = active. Set by public.set_employee_archived() only; there is still no update policy on employees.
alter table public.employees add column archived_at timestamptz;

-- One row per archive or restore: who did it (the Administrator's auth user id; no FK, so the record
-- survives a deleted user), to which Employee ID, what, and when (server time).
create table public.audit_events (
  id          bigint generated always as identity primary key,
  actor       uuid not null,
  target      text not null,
  action      text not null check (action in ('archive', 'restore')),
  occurred_at timestamptz not null default now()
);

-- RLS on with no policies: anon and authenticated can neither read nor write audit rows.
alter table public.audit_events enable row level security;

-- Append-only, for every role the API knows about, the service role included.
revoke update, delete, truncate on public.audit_events from anon, authenticated, service_role;

create function public.audit_events_append_only() returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  raise exception 'audit_events is append-only' using errcode = 'P0001';
end;
$$;

-- The triggers also stop any role that still holds the privilege (for example the table owner).
create trigger audit_events_no_update_delete
  before update or delete on public.audit_events
  for each row execute function public.audit_events_append_only();

create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function public.audit_events_append_only();

-- Archive (p_archived = true) or restore (false) one employee and write its audit row. PostgREST runs
-- one rpc() call in one transaction, so the state change and the audit row commit or fail together.
-- Returns the employee's name for the confirmation message. Errors (SQLSTATE P0001):
--   employee_not_found, already_archived, not_archived, cannot_archive_self.
-- already_archived and not_archived carry the employee's name as the error detail, for the message.
create function public.set_employee_archived(p_employee_id text, p_archived boolean, p_actor uuid)
  returns text
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  v_name text;
  v_archived_at timestamptz;
  v_auth_user_id uuid;
begin
  select name, archived_at, auth_user_id into v_name, v_archived_at, v_auth_user_id
    from employees where employee_id = p_employee_id
    for update;
  if not found then
    raise exception 'employee_not_found' using errcode = 'P0001';
  end if;
  if p_archived and v_archived_at is not null then
    raise exception 'already_archived' using errcode = 'P0001', detail = v_name;
  end if;
  if not p_archived and v_archived_at is null then
    raise exception 'not_archived' using errcode = 'P0001', detail = v_name;
  end if;
  if p_archived and v_auth_user_id = p_actor then
    raise exception 'cannot_archive_self' using errcode = 'P0001';
  end if;

  update employees
    set archived_at = case when p_archived then now() else null end
    where employee_id = p_employee_id;

  insert into audit_events (actor, target, action)
    values (p_actor, p_employee_id, case when p_archived then 'archive' else 'restore' end);

  return v_name;
end;
$$;

-- Only the service role (accounts-store, behind the Administrator-only server actions) may call it.
revoke execute on function public.set_employee_archived(text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.set_employee_archived(text, boolean, uuid) to service_role;
