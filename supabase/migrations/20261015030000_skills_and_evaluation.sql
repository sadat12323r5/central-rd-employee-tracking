-- Story 7.4: record skills assessments and the manager evaluation.
-- ADDITIVE only: two new tables, their indexes, select-only RLS policies, two new functions and their
-- grants. No existing table, column, constraint, index, policy or function is altered or tightened.
--
-- * public.employee_skills: one row per assessed skill of an employee (rated 1-5, with supporting
--   evidence). A skill is identified per employee by its name, case-insensitively (unique index on
--   (employee_id, lower(name))), so rating "react" when "React" exists updates the same row.
-- * public.employee_evaluations: one evaluation summary per employee (strengths, development priorities,
--   readiness), with the reviewer label and date taken from the session at write time.
-- * Reads: the Administrator (JWT app_metadata.role = 'admin') reads every row; an employee reads their
--   own (employees.auth_user_id = auth.uid()); a department manager reads those of employees in their
--   subtree (public.manages_employee, from the manager_scope migration).
-- * Writes: there are no insert, update or delete policies. Rows are written only through the two
--   SECURITY DEFINER functions below (and by scripts/seed-employees.ts with the service role), because
--   the author (updated_by, reviewer) and the review date must come from the session, never the client,
--   and RLS cannot stop a caller forging them or re-pointing employee_id.
-- * Authority (as update_employee_details, Story 7.2): the Administrator for anyone; a department manager
--   for employees in their subtree. Staff never, not even on their own record. A caller whose own employee
--   row is archived is refused. The authority check runs before any lookup, so a non-admin learns nothing
--   about Employee IDs outside their scope.
-- * Values are trimmed with inner whitespace collapsed. Skill name 1-80 characters, evidence 1-300, level
--   an integer 1-5; strengths and development priorities 1-1000, readiness 1-120.
-- * Both functions return the employee's name for the confirmation message. Errors (SQLSTATE P0001):
--   not_authorized, invalid_input, employee_not_found.
-- Nothing is ever deleted (there is no removal feature). The app's assessments-store re-checks the same
-- authority before calling the functions (defence in depth).

create table public.employee_skills (
  id           uuid primary key default gen_random_uuid(),
  employee_id  text not null references public.employees (employee_id) on delete restrict,
  name         text not null check (char_length(btrim(name)) >= 1 and char_length(name) <= 80),
  level        smallint not null check (level between 1 and 5),
  evidence     text not null check (char_length(btrim(evidence)) >= 1 and char_length(evidence) <= 300),
  -- The account that last rated the skill; null for seeded rows.
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The skill identifier: one row per employee and (case-insensitive) skill name. Also serves reads by employee.
create unique index employee_skills_employee_name_key on public.employee_skills (employee_id, lower(name));

create table public.employee_evaluations (
  employee_id             text primary key references public.employees (employee_id) on delete restrict,
  strengths               text not null check (char_length(btrim(strengths)) >= 1 and char_length(strengths) <= 1000),
  development_priorities  text not null check (char_length(btrim(development_priorities)) >= 1 and char_length(development_priorities) <= 1000),
  readiness               text not null check (char_length(btrim(readiness)) >= 1 and char_length(readiness) <= 120),
  reviewer                text not null check (char_length(btrim(reviewer)) >= 1 and char_length(reviewer) <= 200),
  reviewed_on             date not null,
  -- The account that last saved the evaluation; null for seeded rows.
  updated_by              uuid,
  updated_at              timestamptz not null default now()
);

-- No direct writes from API roles (RLS does not govern TRUNCATE): only the functions below and the service role write.
revoke insert, update, delete, truncate on public.employee_skills, public.employee_evaluations from anon, authenticated;

alter table public.employee_skills enable row level security;
alter table public.employee_evaluations enable row level security;

-- Administrators read every row. Roles live in app_metadata, which only the service role can set.
create policy "employee_skills_select_admin" on public.employee_skills
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- An employee reads only their own skills (read-only in the staff portal).
create policy "employee_skills_select_own" on public.employee_skills
  for select to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = employee_skills.employee_id and e.auth_user_id = (select auth.uid())
  ));

-- A department manager reads the skills of employees in their subtree.
create policy "employee_skills_select_managed" on public.employee_skills
  for select to authenticated
  using (public.manages_employee(employee_id));

create policy "employee_evaluations_select_admin" on public.employee_evaluations
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "employee_evaluations_select_own" on public.employee_evaluations
  for select to authenticated
  using (exists (
    select 1 from public.employees e
    where e.employee_id = employee_evaluations.employee_id and e.auth_user_id = (select auth.uid())
  ));

create policy "employee_evaluations_select_managed" on public.employee_evaluations
  for select to authenticated
  using (public.manages_employee(employee_id));

-- Rates one skill of an employee: inserts it, or (same name, any case) updates its level and evidence,
-- keeping the stored name.
create function public.rate_employee_skill(p_employee_id text, p_name text, p_level integer, p_evidence text)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_name text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_evidence text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_evidence, ''), '\s+', ' ', 'g'));
  v_employee text;
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

  if v_name = '' or pg_catalog.char_length(v_name) > 80
    or v_evidence = '' or pg_catalog.char_length(v_evidence) > 300
    or p_level is null or p_level < 1 or p_level > 5 then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;

  select e.name into v_employee
    from public.employees e
    where e.employee_id = p_employee_id;
  if not found then
    raise exception 'employee_not_found' using errcode = 'P0001';
  end if;

  insert into public.employee_skills (employee_id, name, level, evidence, updated_by)
    values (p_employee_id, v_name, p_level, v_evidence, auth.uid())
    on conflict (employee_id, (pg_catalog.lower(name))) do update
      set level = excluded.level, evidence = excluded.evidence, updated_by = excluded.updated_by, updated_at = pg_catalog.now();

  return v_employee;
end;
$$;

-- Saves an employee's evaluation summary (one per employee). The reviewer label and the review date come
-- from the session: the caller's linked employee name followed by " · Administrator" or
-- " · Department manager" (an Administrator with no linked employee is "Administrator"), dated today in
-- the Asia/Dhaka org timezone.
create function public.update_employee_evaluation(
  p_employee_id text, p_strengths text, p_development_priorities text, p_readiness text
)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_strengths text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_strengths, ''), '\s+', ' ', 'g'));
  v_priorities text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_development_priorities, ''), '\s+', ' ', 'g'));
  v_readiness text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_readiness, ''), '\s+', ' ', 'g'));
  v_is_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  v_author text;
  v_reviewer text;
  v_employee text;
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

  if not (v_is_admin or coalesce(public.manages_employee(p_employee_id), false)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if v_strengths = '' or pg_catalog.char_length(v_strengths) > 1000
    or v_priorities = '' or pg_catalog.char_length(v_priorities) > 1000
    or v_readiness = '' or pg_catalog.char_length(v_readiness) > 120 then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;

  select e.name into v_employee
    from public.employees e
    where e.employee_id = p_employee_id;
  if not found then
    raise exception 'employee_not_found' using errcode = 'P0001';
  end if;

  select e.name into v_author
    from public.employees e
    where e.auth_user_id = auth.uid()
    order by e.employee_id
    limit 1;
  v_reviewer := case
    when v_author is null then case when v_is_admin then 'Administrator' else 'Department manager' end
    else pg_catalog.left(v_author, 170) || case when v_is_admin then ' · Administrator' else ' · Department manager' end
  end;

  insert into public.employee_evaluations
      (employee_id, strengths, development_priorities, readiness, reviewer, reviewed_on, updated_by, updated_at)
    values (
      p_employee_id, v_strengths, v_priorities, v_readiness, v_reviewer,
      (pg_catalog.now() at time zone 'Asia/Dhaka')::date, auth.uid(), pg_catalog.now()
    )
    on conflict (employee_id) do update
      set strengths = excluded.strengths, development_priorities = excluded.development_priorities,
          readiness = excluded.readiness, reviewer = excluded.reviewer, reviewed_on = excluded.reviewed_on,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  return v_employee;
end;
$$;

-- Signed-in users only. anon is revoked explicitly too, since Supabase's default privileges grant it
-- execute on new public functions.
revoke execute on function public.rate_employee_skill(text, text, integer, text) from public, anon;
revoke execute on function public.update_employee_evaluation(text, text, text, text) from public, anon;
grant execute on function public.rate_employee_skill(text, text, integer, text) to authenticated;
grant execute on function public.update_employee_evaluation(text, text, text, text) to authenticated;

-- No insert, update or delete policies.
