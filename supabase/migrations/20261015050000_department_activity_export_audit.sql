-- Story 8.3: audit each department manager's bulk activity export. Classification: ADDITIVE, a new
-- function only. It writes to the audit_events columns and the 'export_activity' action added in
-- 20261013000000_activity_export_audit.sql; the table stays append-only with RLS on and no policies.

-- Records one bulk activity export by a department manager (the actor's auth user id). Called only after
-- every source was read, before the CSV is handed out. The target is 'departments:' followed by the
-- manager's subtree department ids at export time (distinct, sorted, comma-separated), with '+archived'
-- appended when archived employees were included. Returns the audit row id.
-- Errors (SQLSTATE P0001): invalid_period, invalid_scope.
create function public.record_department_activity_export(
  p_actor uuid, p_department_ids uuid[], p_include_archived boolean, p_from date, p_to date
)
  returns bigint
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  v_id bigint;
  v_ids text;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid_period' using errcode = 'P0001';
  end if;

  select string_agg(d::text, ',' order by d::text) into v_ids
    from (select distinct d from unnest(p_department_ids) as d where d is not null) ids(d);
  if v_ids is null then
    raise exception 'invalid_scope' using errcode = 'P0001';
  end if;

  insert into audit_events (actor, target, action, period_from, period_to)
    values (
      p_actor,
      'departments:' || v_ids || case when coalesce(p_include_archived, false) then '+archived' else '' end,
      'export_activity', p_from, p_to
    )
    returning id into v_id;

  return v_id;
end;
$$;

-- Only the service role (audit-store, behind the export action's manager check) may call it.
revoke execute on function public.record_department_activity_export(uuid, uuid[], boolean, date, date) from public, anon, authenticated;
grant execute on function public.record_department_activity_export(uuid, uuid[], boolean, date, date) to service_role;
