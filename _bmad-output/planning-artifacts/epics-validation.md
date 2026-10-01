---
validates: '_bmad-output/planning-artifacts/epics.md'
validated: '2026-10-01'
sources:
  - '_bmad-output/planning-artifacts/prds/prd-AI-DLC-Employee-management-2026-09-25/prd.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md'
  - 'docs/SRS.md (section 11)'
verdict: 'PASS WITH FIXES (not dev-ready as written)'
---

# Epics & Stories Validation Report

## Re-check (2026-10-01, against the rewritten epics.md: 7 epics, 31 stories)

**Re-check verdict: PASS WITH FIXES.** The original blocker and 8 of the 10 majors are resolved. M5 and M6 are partly resolved. The rewrite also introduced or exposed 5 new major findings (N1–N5) and no new blockers. The numbering below (1.1–1.5, 4.1–4.9) refers to the **new** document.

| ID | Status | Evidence |
| --- | --- | --- |
| B1 | Resolved | The spine defines a third session role, `manager`, derived each request. Story 4.2 adds the role. Story 4.4 hides the Interviews tab and org-wide interviews view from managers, and tests that a direct manager query returns zero rows. N1 and N2 are follow-ups to this fix. |
| M1 | Resolved | Employee persistence is now 1.1, ahead of sign-in (1.2), provisioning (1.3) and archive (1.4). |
| M2 | Resolved | Epic 5 and the dependency-flow line now declare Epic 4. |
| M3 | Resolved | The transfer check moved to 4.8, and 3.1 now has a "no department field" schema AC instead. |
| M4 | Resolved | 4.2 (role), 4.3 (portal scoping plus RLS on employees, attendance and training) and 4.5 (RLS on assignments) cover it. The Definition of Done (DoD) requires an RLS policy on every new table. 4.3 is still sizeable but workable. |
| M5 | Partly resolved | The dedup rule and the stub's data source are fixed. N3 and N4 remain. |
| M6 | Partly resolved | 5.4 now computes the whole attendance summary from real data. The fixture fields `joined`, `summary`, `initials`/`color`, `work.update` and `work.commits` still have no owning story, so the Epic 7 header's "seeding only" claim does not yet hold. See N5. |
| M7 | Resolved | Epic 7 lists the SRS 11.3 deferrals explicitly. |
| M8 | Resolved | 1.1 and 1.5 now have database-unreachable states, and 3.2 has a loading state. |
| M9 | Resolved | 4.7 covers owner edit and withdraw, and rejects edits or withdrawals by the Administrator or a manager. |
| M10 | Resolved | 4.5 locks client, project name, department, allocation and start date after creation. |

### New major findings
- **N1 (4.2):** The 4.2 seed makes the Administrator the manager of L&D. Under the spine's rule, any account that manages a Department derives the `manager` role. No story says which role wins for the Administrator. A naive implementation would downgrade the L&D manager's session to `manager`, which loses org-wide access and hides interviews. **Fix:** add an AC in 4.2 that `admin` always takes precedence over `manager`.
- **N2 (4.2, 4.3):** Sessions carry exactly one role, and a manager is also an employee. No story says how a manager reaches their own staff self-service:
  - clocking in (1.5)
  - reporting their own interviews (2.1), which 4.4 hides from the management portal
  - viewing their own training (3.x)
  - recording their own leave (5.2)
  - backfilling their own projects (4.7)

  **Fix:** add an AC defining the manager's access to their own records, for example a "My portal" route inside the management portal.
- **N3 (3.1, 3.2):** FR-5 has regressed. The old AC that LMS-synced entries display alongside pre-LMS history was dropped. With the strict split, an LMS course that completes never enters history, so FR-5's "pre-LMS history alongside LMS-synced entries" consequence is uncovered. **Fix:** define how completed LMS enrolments reach history, or defer it explicitly until the real LMS is connected.
- **N4 (3.1, 3.2):** The org-wide Learning & Development view now reads only completed training (3.1). Story 3.2 covers in-progress data for the per-employee Training tab only, and also stops all runtime fixture reads. Nothing says where the org-wide view's in-progress figures come from after 3.2, so they will silently disappear. The view also needs a per-employee LMS call (N calls) or a bulk contract that AD-3 doesn't have.
- **N5 (4.5):** This issue was already present before the rewrite and is newly found. The fixture's `work` record has `project`, `role`, `allocation`, a weekly `period`, `update` and `commits`. It has no `client` and no start date, so 4.5's "move current work into assignments" AC can't produce valid Assignment rows as written. `update`, `commits` and `role` also have no destination. **Fix:** name the defaults or placeholder values, and where the unmapped fields go.

### Previous minors
- Most are now covered by the new DoD, the Epic 1 preconditions, 4.1 (unique names, no delete), 4.2 (seed, Administrator-only department list, no-account rejection), 4.6 (Staff write rejection) and 4.9 (higher-authority guard).
- One small new gap: before 1.2 and 1.3, the running app still uses the HMAC demo sessions, but 1.1's RLS assumes Supabase auth identities. 1.1 should say how the app queries the database in the meantime, for example a server-side service role with store-level scoping.

---

## Original validation (pre-rewrite)

**Verdict: PASS WITH FIXES.** The structure is sound (7 epics, 27 stories, every FR-1..FR-11 traced, most AD rules reflected faithfully, Given/When/Then used throughout). It is not ready for developers as written: there is 1 blocker and 10 major findings. None of them needs the epics restructured. Each one is fixed by adding or rewording acceptance criteria, reordering stories, or declaring a dependency.

| Severity | Count |
| --- | --- |
| Blocker | 1 |
| Major | 10 |
| Minor | 18 |

---

## Blocker

### B1. The Department Manager role model is undefined, which puts FR-3 interview privacy at risk (4.2, and also 4.3–4.7, 5.2, 7.1)
- Story 1.1 freezes the session as `admin | staff + employeeId` and says "`page.tsx` routing doesn't change". Story 4.2 then has a Department Manager "sign into the management portal", but it never says how that account is represented.
- If the manager account is given the `admin` role so it can reach the management portal, Story 2.1's RLS check ("is this the employee, or an Administrator") lets that manager read interviews. That breaks FR-3 and the AD-1 interviews exception, which exist specifically to exclude Department Managers.
- If the manager account stays `staff`, it cannot open the management portal (Story 1.2 AC), so Story 4.2 cannot be built without changing the session union and routing. Story 1.1 says those don't change.
- Story 4.2 also has no AC for the parts of the management portal a scoped manager must not see:
  - the profile Interviews tab
  - the org-wide "Interviews & placements" view
  - org-wide Learning & Development, attendance and leave views, and CSV export, beyond their subtree
- **Fix:** add a story (or ACs in 4.2) that defines a distinct manager capability that is *not* the Administrator role. Story 4.2 needs these ACs:
  - the session or role shape for managers
  - Interviews tab and org-wide interviews view are hidden and return nothing for managers
  - every org-wide view and export is limited to the manager's subtree
  - an explicit test that a manager's interview query returns zero rows, even within their own department

---

## Major

### M1. Forward dependency inside Epic 1: Stories 1.1–1.3 need the employees table and store that only 1.4 creates (1.1, 1.2, 1.3, 1.4)
- Story 1.1 maps a signed-in account to `employeeId` for the session union.
- Story 1.2 creates an account "for an existing employee" and rejects duplicates per employee.
- Story 1.3 hides archived employees from the directory.
- All three need employee records. Until 1.4, those live only in the compiled fixture, which `auth.ts` imports directly (the AD-1 violation). The `accounts` table cannot have a foreign key to employees that aren't in the database yet, and the directory's "archived" filter has to join account status onto fixture data.
- **Fix:** move 1.4 to the front of Epic 1 (it carries no auth dependency beyond RLS role claims). Alternatively, have 1.1 create `employees-store` and the employees table.

### M2. Epic 5 depends on Epic 4, but the dependency is not declared (5.2, 5.3)
- Story 5.2 lets "a manager for someone in their department" record leave and rejects managers outside it. Story 5.3 reuses the same authority. Both need departments and managers (4.1/4.2) and the AD-4 chain walk.
- Epic 5's header says it depends only on Epic 1, and the dependency flow line says "Epic 1 gates Epics 2–5 and 7; Epic 4 gates Epic 7".
- **Fix:** declare Epic 4 → Epic 5. Alternatively, split the manager-scoped ACs into a later story that is explicitly gated on Epic 4.

### M3. Story 3.1 tests a transfer that only exists in Epic 4 (3.1)
- The AC "Given an employee who has transferred out of L&D…" cannot be set up or tested in Epic 3. Departments arrive in 4.1 and transfers in 4.6.
- **Fix:** move this AC to 4.6 ("after transfer, training history still shows"), or reword 3.1 as a structural guarantee: enrolment rows carry no `department_id`, so history is not filtered by department.

### M4. RLS and scoping are not reworked for Department Managers, and Story 4.2 is too large for one session (1.4, 1.5, 2.1, 3.1, 4.2, 4.3)
- The RLS policies written in 1.4 (employees), 1.5 (attendance), 3.1 (training) and 4.3 (assignments) cover only `admin` and `staff`.
- Story 4.2 says a manager "sees and acts only on employees in that department and its sub-departments", but it has no AC to extend each of those tables' policies (and the app-layer store checks) to subtree scoping.
- Story 4.2 currently implies all of the following in one story:
  - a new role
  - manager assignment
  - the `departments.ts` walker
  - scoping across directory, profiles, org views, export and attendance
  - RLS rework on 4–5 tables
- That is too much for one dev session. "Acts on" is also vague.
- **Fix:** split 4.2 into three stories:
  - (a) assign manager plus the authority walker
  - (b) management portal scoping and RLS updates, listing each table and view
  - (c) the interview exclusion from B1

### M5. The boundary between training history (3.1) and LMS current enrolments (3.2) is ambiguous (3.1, 3.2, 7.4)
- Story 3.1 moves "the existing fixture training data" (which includes in-progress items) into a training table and shows "completion or target date". Story 3.2's stub returns "in-progress training from the existing demo data".
- So in-progress items will appear twice, once from the history table and once from the stub, unless one of the stories excludes them. AD-3 puts the merge in `training-store`, but no AC defines the merge or dedup rule.
- The stub's source is also undefined. If it reads `src/data/employees.ts`, that contradicts 7.4 ("no profile data is served from `src/data/employees.ts` any more").
- **Fix:**
  - 3.1 migrates only completed entries (or flags in-progress rows as LMS-sourced).
  - 3.2 states the stub's data source and the dedup rule in `training-store`.

### M6. Story 7.4's "nothing is served from the fixture" end state can't be reached (7.4, 1.4, 5.4)
- Story 1.4 leaves skills, employment history, the evaluation summary and the **attendance summary** in the fixture.
- Epic 7 migrates employment history (7.3) and skills plus evaluation (7.4). No story migrates the attendance summary. Story 5.4 replaces leave days only, and Epic 7 doesn't depend on Epic 5.
- The LMS stub (M5) may also still read the fixture.
- **Fix:** add an AC or story that migrates the attendance summary (or derives it from 1.5 and Epic 5 data). Alternatively, soften 7.4's AC to name exactly which data it moves out of the fixture.

### M7. Epic 7 claims SRS 11.3 coverage, but parts of it are uncovered and not deferred (Epic 7)
- SRS 11.3 lists these as editable: employment history, **training enrolments**, skill assessments, current assignments, **interview outcomes**, and **attendance/leave entries**. PRD §4.5 lists "attendance/leave".
- No story lets the Administrator edit or correct attendance (timesheet) entries.
- No story lets the Administrator or the employee create or edit non-LMS training entries.
- Interview-outcome editing by the Administrator is explicitly read-only per the FR-2 interim rule, which is consistent with the PRD, but it is not recorded as deferred under 11.3.
- SRS 11.3's audit requirement for security-relevant mutations is met only for archive, restore and transfer.
- **Fix:** either add stories (attendance correction, training entry create/edit), or record these in the Epic 7 header as explicitly deferred with a pointer to PRD §8 Open Question 2.

### M8. The NFR-REL-001 successor is not applied to Supabase reads (Epic 1, 3.2)
- The inventory states the successor contract (AD-3): *every* network-dependent read, including Supabase, surfaces a stale, unavailable or loading state.
- No Epic 1 story (1.4, 1.5) has an AC for the database being unreachable.
- Story 3.2 covers stale and unavailable but not loading.
- **Fix:** add "database unavailable → clear error state, not partial data" ACs to 1.4 and 1.5, and add a loading state to 3.2.

### M9. FR-8 editing of the employee's own backfilled entry is not covered (4.5)
- FR-8's consequence is that "a Staff member can only create/edit their own Backfilled Project Entries". Story 4.5 only covers *adding*, plus rejecting other Staff.
- No AC lets the owner edit, and it isn't defined whether the owner can withdraw or remove an entry (the "nothing deleted" pattern used for interviews and employment history).
- It also doesn't say whether the Administrator or a manager may edit a backfilled entry. Under AD-2's single writer, they should not.
- **Fix:** add owner-edit (and withdraw, if wanted) ACs, plus an AC that rejects edits by the Administrator or a manager.

### M10. Assignment field immutability is missing (4.3, 4.4)
- The FR-6/FR-7 consequence and the spine's Field-immutability convention say client, project, Department, allocation and dates lock after creation; only status and outcome stay editable.
- Story 4.3 has no "edit is rejected" AC, and Story 4.4 has no AC that writing an evaluation leaves the assignment's fields unchanged. As written, a dev could ship an "edit assignment" action.
- **Fix:** add a "change to client/project/department/allocation/start date is rejected" AC to 4.3.

---

## Minor

1. **1.3**: The AuditEvent table is created implicitly. Story 1.3 is the right first-user, but the AC should say so explicitly ("creates the append-only `audit_events` table: actor, target, action, server timestamp"). Stories 4.6 and 4.7 then reuse it, so there is no orphan table.
2. **1.1**: The bootstrap seed script creates the first Administrator outside "created by an Administrator" (AD-6). This is reasonable, but call it out as the single sanctioned exception, run once, with no runtime route.
3. **Epic 1 precondition**: lists only the Supabase project. PRD §4.7/§6.2 says the gating decisions (org timezone, retention periods) block §4.4 too, so add them.
4. **Epic 1**: NFR-SEC-003 (demo banner) and NFR-SEC-002 (Supabase keys from env, `DEMO_*` secrets retired) have no AC. Once real accounts exist, the "all data fictional" banner policy needs a decision.
5. **2.1, 3.1, 7.4**: SRS 11.2 uniqueness constraints on interview, training and skill identifiers are not in the ACs. Only Employee ID and email are covered (1.4).
6. **4.1, 4.2**: The AD-5 seed says L&D is "managed by the Administrator", but neither story seeds that manager link.
7. **4.2**: No AC rejects Department Managers editing the department list. FR-10 says this is Administrator-only, and 4.1 only rejects Staff.
8. **4.1**: Department deletion or retirement and duplicate names are unaddressed. Is deletion allowed if the department has members, assignments or backfills?
9. **4.2**: AD-6 says an action that needs an account calls `accounts-store.create()`. Story 4.2 allows only "existing account", so say what happens when the person has none.
10. **4.4, 4.5 vs FR-9**: FR-9 (and the inventory line) says history is visible to "the reporting employee and Administrators only", but the stories let authorized Department Managers view it (consistent with PRD §3). The PRD wording needs reconciling, and the inventory line should be updated.
11. **4.4**: There is no explicit AC that the employee (or any Staff) writing or amending an evaluation is rejected at the server. Only "read-only" in the UI is stated.
12. **3.2**: There is no AC asserting enrolments carry no department (stated only in the epic intro).
13. **5.3**: "no longer counts toward attendance totals" refers to totals that only become real in 5.4. This is a soft forward reference, so move it to 5.4.
14. **5.1**: The "unsupported year" AC exercises leave calculation, which has no caller until 5.2. Reword it as a domain or store-level check.
15. **AD-7 consistency**: zod validation is stated in 1.1, 2.1, 5.2 and 7.1 but absent from 1.2, 1.3, 2.2, all of Epic 4, 5.1, 5.3 and 7.2–7.4. Either state it globally once as a Definition of Done or add it to each story.
16. **Testing convention**: the spine's "every new `src/domain`/`src/server` module gets a `tests/*.test.ts`" rule, and the RLS test strategy (still deferred), appear in no AC or DoD.
17. **Format**: several stories hang unrelated `And` clauses off an unrelated Given/When/Then, for example in 1.1, 1.2, 1.3, 1.4, 2.1, 4.4, 4.6, 5.2 and 7.1. These should be separate scenarios or a "Constraints" list. Story 4.7 also doesn't cover a manager archiving the Administrator or a higher manager whose employee record sits in their subtree.
18. **Epic 6 (6.1 vs 6.3)**: there is tension between "a small set of named colours" plus "keep the current look / change only failing colours" and "no hard-coded colour values remain" across 106 distinct colours. Story 6.3 may become a large tokenisation job. Decide whether non-failing colours become tokens verbatim.

---

## Check-by-check summary

### 1. FR coverage
| FR | Story | Fully satisfied? |
| --- | --- | --- |
| FR-1 | 2.1 | Yes |
| FR-2 | 2.2 | Yes. Locks, withdrawal, author-only edits and the Administrator read-only rule are all present. |
| FR-3 | 2.1 | At the database level yes, but exposed by B1 (manager role model). |
| FR-4 | 3.2 | Mostly. Loading state (M8), stub source and dedup (M5). |
| FR-5 | 3.1 | Mostly. Transfer AC (M3), in-progress overlap (M5). |
| FR-6 | 4.3 | Missing field immutability (M10). |
| FR-7 | 4.4 | Yes, apart from minor #11. |
| FR-8 | 4.5 | Missing owner edit (M9). |
| FR-9 | 4.4, 4.5 | Yes for Staff, but the PRD wording conflicts with manager access (minor #10). |
| FR-10 | 4.1 | Mostly (minors #6–8). |
| FR-11 | 4.6 | Yes. All five PRD consequences present. |

- **PRD §4.5 / SRS 11.3:** partial (M6, M7).
- **PRD §4.6 / SRS 11.4:** covered by Epic 5, apart from the undeclared Epic 4 dependency (M2).
- **PRD §4.8 / SRS 11.7:** covered (minor #18).
- **SRS 11.1:** covered (1.1–1.3, 4.7).
- **SRS 11.2:** RLS is covered for employees, attendance, interviews and training. Identifier uniqueness is partial (minor #5), and "authorized at API and database" for Department Managers is missing (M4).

### 2. Table and entity creation
| Table | Created in |
| --- | --- |
| accounts | 1.1 |
| audit_events | 1.3 (implicit, minor #1) |
| employees | 1.4, but used in 1.1–1.3 (M1) |
| attendance | 1.5 |
| interviews | 2.1 |
| training | 3.1 |
| departments | 4.1 |
| manager link | 4.2 |
| assignments | 4.3 |
| evaluations | 4.4 |
| backfilled entries | 4.5 |
| holiday calendar | 5.1 |
| leave | 5.2 |
| employment history | 7.3 |
| skills / evaluation summary | 7.4 |

- Nothing is created upfront.
- The only out-of-order use is employees in 1.1–1.3 (M1).
- The attendance summary has no owner (M6).

### 3. Forward dependencies
- Inside Epic 1: 1.1–1.3 need 1.4 (M1).
- Epic 3 needs Epic 4: Story 3.1's transfer AC (M3).
- Epic 5 needs Epic 4: manager-scoped leave in 5.2 and 5.3 (M2).
- Inside Epic 5: 5.3 refers to totals built in 5.4 (minor #13).
- Epic 7 needs Epic 4: correctly declared.
- Department managers before Epic 4: none. Every manager reference is in 4.2 or later, apart from the forward-looking design note in 2.1, which is fine.
- Archive by managers: correctly deferred to 4.7, which builds on 1.3 and 4.2.
- Holiday calendar: 5.1 comes before 5.2. Correct.
- Management portal for managers (4.2): its dependencies are undefined (B1, M4).

### 4. Story quality
- **Too big:** 4.2 (M4). Borderline: 1.1 (the Supabase Auth cutover plus the seed), 1.4 (migration, RLS and the store refactor), and 6.3 (full tokenisation).
- **Vague:** 4.2 "acts only on" and 3.1 "look the same as before". The latter is acceptable because existing tests anchor it.
- **Format:** Given/When/Then is used everywhere, but unrelated `And` clauses are chained onto scenarios (minor #17).

### 5. Architecture compliance (AD-1..AD-7)
- **Rules the stories match:**
  - Interviews "is Administrator" exception (2.1)
  - Frozen assignment department (4.3)
  - Transfer blocked by an open assignment (4.6)
  - Archive semantics: next request, history kept, archived filter, restore, audit, and Staff rejected (1.3, 4.7)
  - Cycle rejection at the store (4.1) plus the walker guard (4.2)
  - Evaluation authority set, fresh at write time, with amendments and authoredBy (4.4)
  - Separate records with provenance (4.4, 4.5)
  - One evaluation per assignment checked in the store (4.4)
  - LMS contract and sole caller (3.2)
  - No self-registration (1.1)
- **No story directly contradicts an AD.** The risks are omissions and ambiguities:
  - B1 could defeat the AD-1 interviews exception.
  - M10 omits the immutability convention.
  - M5 risks a second path to fixture data, against the intent of AD-3.
  - Minor #2 is the AD-6 bootstrap exception.
  - Minor #15 is uneven AD-7 coverage.

### 6. Epic structure
- Epics are framed around user value. Epic 1 is the closest to a technical milestone, but each story carries an actor and an outcome, which is acceptable for a brownfield release gate.
- Epic 6 is independent and correctly marked as such.
- **File churn:**
  - RLS policies and store scoping written in Epics 1–3 must be reopened in Epic 4 for managers (M4).
  - The Current work tab is touched in 4.3 and again in 4.5 (expected).
  - `src/data/employees.ts` is touched in 1.4, 2.1, 3.1, 4.3, 7.3 and 7.4. This is incremental migration by design, but its end state is incomplete (M6).
  - `styles.css` is touched in all three Epic 6 stories. That is intended.
