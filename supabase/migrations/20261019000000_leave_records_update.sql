-- Story 5.3: edit or cancel a leave period.
-- ADDITIVE only: one new RLS policy. Nothing existing (tables, columns, constraints, policies, functions,
-- triggers or grants) is altered.
--
-- * Who may change an employee's leave: exactly who may record it (Story 5.2) — the Administrator (JWT
--   app_metadata.role = 'admin') for anyone; the employee themselves (employees.auth_user_id = auth.uid());
--   a department manager for employees in their subtree (public.manages_employee). The same predicate as
--   leave_records_select / leave_records_insert guards both the row being changed (using) and the row as
--   changed (with check). The app's leave-store re-checks the same authority before every write.
-- * What may change is owned by the 5.2 guard trigger (leave_records_guard), unchanged here: id,
--   employee_id, created_by and created_at are locked; a cancelled row can no longer be changed;
--   cancelling sets cancelled_at (stamped now()) and may not change anything else; an edit is recounted
--   against the active (highest) calendar version and checked for overlap with the employee's other
--   non-cancelled periods (the row itself excluded).
-- * Still no delete policy: leave is cancelled, never deleted (the BEFORE DELETE trigger refuses every delete).
-- Seeding: none.

create policy "leave_records_update" on public.leave_records
  for update to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.employees e
      where e.employee_id = leave_records.employee_id and e.auth_user_id = (select auth.uid())
    )
    or public.manages_employee(employee_id)
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.employees e
      where e.employee_id = leave_records.employee_id and e.auth_user_id = (select auth.uid())
    )
    or public.manages_employee(employee_id)
  );

-- No delete policy.
