-- Story 4.9: department managers archive and restore accounts in their own department subtree.
-- ADDITIVE only: one new function and its grants. No existing function, policy, column or constraint is
-- altered. public.set_employee_archived stays service-role only and untouched (the Administrator path).
--
-- * public.manager_set_employee_archived(employee, archived) is called through the manager's own JWT
--   (the app's user client, never the service role). The actor is always auth.uid(), never a parameter,
--   so the authority check, the rank check and the audit actor cannot be supplied by the caller.
-- * It is SECURITY DEFINER because the rank check needs ancestor departments and auth.users, which a
--   manager's JWT cannot read, and because there is no update policy on employees. It exposes only the
--   employee's name (already visible to an in-scope manager) and the error codes below.
-- * A caller whose own employee row is archived is not_authorized: their JWT may still be valid until it
--   expires, and a direct rpc call skips the app's per-request archive check.
-- * Authority: public.manages_employee(p_employee_id) (Story 4.3), the same subtree rule the app uses.
-- * Rank (archive and restore): the target is rejected when it is an Administrator, or when it manages any
--   department on the ancestor-or-self chain of the caller's own employee department or of any department
--   the caller manages (that is, the target has equal or higher authority than the caller). A target that
--   only manages departments below the caller is lower and may be archived. The walk uses UNION, so a
--   cycle in the stored hierarchy still terminates.
-- * As in set_employee_archived, PostgREST runs one rpc() call in one transaction, so the state change and
--   its audit_events row commit or fail together.
-- Errors (SQLSTATE P0001): not_authorized, employee_not_found, cannot_archive_self, insufficient_authority,
-- already_archived, not_archived. already_archived and not_archived carry the employee's name as detail.

create function public.manager_set_employee_archived(p_employee_id text, p_archived boolean)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text;
  v_archived_at timestamptz;
  v_auth_user_id uuid;
begin
  if v_actor is null then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  -- An archived caller has no authority, even while their JWT is still valid (direct rpc calls bypass
  -- the app's per-request archive check).
  if exists (select 1 from public.employees ce where ce.auth_user_id = v_actor and ce.archived_at is not null) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  select e.name, e.archived_at, e.auth_user_id into v_name, v_archived_at, v_auth_user_id
    from public.employees e
    where e.employee_id = p_employee_id
    for update;
  if not found then
    raise exception 'employee_not_found' using errcode = 'P0001';
  end if;

  -- Same error whether the employee is outside the caller's subtree or the caller manages nothing.
  if not public.manages_employee(p_employee_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if p_archived and v_auth_user_id = v_actor then
    raise exception 'cannot_archive_self' using errcode = 'P0001';
  end if;

  if v_auth_user_id is not null then
    if exists (
      select 1 from auth.users u
        where u.id = v_auth_user_id and (u.raw_app_meta_data ->> 'role') = 'admin'
    ) then
      raise exception 'insufficient_authority' using errcode = 'P0001';
    end if;

    if exists (
      with recursive chain (id, parent_department_id, manager_user_id) as (
        select d.id, d.parent_department_id, d.manager_user_id
          from public.departments d
          where d.id in (select ce.department_id from public.employees ce where ce.auth_user_id = v_actor)
             or d.manager_user_id = v_actor
        union
        select p.id, p.parent_department_id, p.manager_user_id
          from public.departments p
          join chain c on p.id = c.parent_department_id
      )
      select 1 from chain where chain.manager_user_id = v_auth_user_id
    ) then
      raise exception 'insufficient_authority' using errcode = 'P0001';
    end if;
  end if;

  if p_archived and v_archived_at is not null then
    raise exception 'already_archived' using errcode = 'P0001', detail = v_name;
  end if;
  if not p_archived and v_archived_at is null then
    raise exception 'not_archived' using errcode = 'P0001', detail = v_name;
  end if;

  update public.employees
    set archived_at = case when p_archived then now() else null end
    where employee_id = p_employee_id;

  insert into public.audit_events (actor, target, action)
    values (v_actor, p_employee_id, case when p_archived then 'archive' else 'restore' end);

  return v_name;
end;
$$;

-- Signed-in users only. anon is revoked explicitly too, since Supabase's default privileges grant it
-- execute on new public functions. A plain Staff caller gets not_authorized from the function itself.
revoke execute on function public.manager_set_employee_archived(text, boolean) from public, anon;
grant execute on function public.manager_set_employee_archived(text, boolean) to authenticated;
