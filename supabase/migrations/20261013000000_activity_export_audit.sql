-- Story 8.1: audit each activity export. Classification: DESTRUCTIVE, because the existing check
-- constraint on audit_events.action is dropped and replaced; the replacement only widens it (it also
-- allows 'export_activity'), so every existing row still satisfies it. The two new columns are nullable,
-- and the table stays append-only with RLS on and no policies.

-- The exported period (inclusive Asia/Dhaka calendar dates). Null on archive/restore rows.
alter table public.audit_events
  add column period_from date,
  add column period_to date;

alter table public.audit_events drop constraint audit_events_action_check;
alter table public.audit_events
  add constraint audit_events_action_check check (action in ('archive', 'restore', 'export_activity'));

-- Export rows always record a period, never reversed; other rows never have one.
alter table public.audit_events
  add constraint audit_events_period_check check (
    (action <> 'export_activity' and period_from is null and period_to is null)
    or (action = 'export_activity' and period_from is not null and period_to is not null and period_from <= period_to)
  );

-- Records one activity export of one employee by an Administrator (the actor's auth user id). Called
-- only after every source was read, before the CSV is handed out. Returns the audit row id.
-- Errors (SQLSTATE P0001): employee_not_found, invalid_period.
create function public.record_activity_export(p_actor uuid, p_employee_id text, p_from date, p_to date)
  returns bigint
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  v_id bigint;
begin
  if not exists (select 1 from employees where employee_id = p_employee_id) then
    raise exception 'employee_not_found' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid_period' using errcode = 'P0001';
  end if;

  insert into audit_events (actor, target, action, period_from, period_to)
    values (p_actor, p_employee_id, 'export_activity', p_from, p_to)
    returning id into v_id;

  return v_id;
end;
$$;

-- Only the service role (audit-store, behind the Administrator-only export action) may call it.
revoke execute on function public.record_activity_export(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.record_activity_export(uuid, text, date, date) to service_role;
