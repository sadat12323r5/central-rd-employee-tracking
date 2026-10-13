-- Story 8.2: audit each bulk activity export (every employee). Classification: ADDITIVE, a new function
-- only. It writes to the audit_events columns and the 'export_activity' action added in
-- 20261013000000_activity_export_audit.sql; the table stays append-only with RLS on and no policies.

-- Records one bulk activity export by an Administrator (the actor's auth user id). Called only after
-- every source was read, before the CSV is handed out. The target is 'all-employees', or
-- 'all-employees+archived' when archived employees were included. Returns the audit row id.
-- Errors (SQLSTATE P0001): invalid_period.
create function public.record_bulk_activity_export(p_actor uuid, p_include_archived boolean, p_from date, p_to date)
  returns bigint
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  v_id bigint;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid_period' using errcode = 'P0001';
  end if;

  insert into audit_events (actor, target, action, period_from, period_to)
    values (
      p_actor,
      case when coalesce(p_include_archived, false) then 'all-employees+archived' else 'all-employees' end,
      'export_activity', p_from, p_to
    )
    returning id into v_id;

  return v_id;
end;
$$;

-- Only the service role (audit-store, behind the Administrator-only export action) may call it.
revoke execute on function public.record_bulk_activity_export(uuid, boolean, date, date) from public, anon, authenticated;
grant execute on function public.record_bulk_activity_export(uuid, boolean, date, date) to service_role;
