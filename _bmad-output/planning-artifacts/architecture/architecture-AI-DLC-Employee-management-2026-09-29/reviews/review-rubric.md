---
title: Rubric Review — ARCHITECTURE-SPINE (L&D Manager Workspace)
reviewed: ARCHITECTURE-SPINE.md (created 2026-09-29, updated 2026-09-30)
against:
  - docs/ARCHITECTURE.md (brownfield, as-implemented + production target)
  - PRD (prd-AI-DLC-Employee-management-2026-09-25) FR-1..FR-10
reviewer-date: 2026-09-30
---

# Rubric Walk — ARCHITECTURE-SPINE.md

## Overall Verdict

**Conditional pass.** The spine's six ADs are well-formed, correctly bound to specific FRs, and — where they engage with the brownfield codebase — genuinely ratify it (correctly names the pre-existing `auth.ts` fixture-import violation, matches `AttendanceStore`'s existing shape, matches the production-target `docs/ARCHITECTURE.md` table for identity/persistence). The PRD's FR-1..FR-10 are all placed in the Capability → Architecture Map with a plausible governing AD. However, the spine is **silent on the entire operational/environmental envelope** — the one dimension the initiative altitude most needs to own here, given the Supabase persistence migration (SRS 11.1/11.2) is explicitly bound in its own frontmatter and is the single largest piece of work ahead. There are also no enforcement mechanisms behind any Rule, one dangling internal cross-reference, and one Deferred item that drops a PRD-stated interim default, leaving room for two independently-built stories to diverge.

## Findings by Severity

- **Critical: 1**
- **High: 2**
- **Medium: 3**
- **Low: 2**

---

## Critical

### C-1. No deployment/environment/infra strategy anywhere — the Stack table's one line ("Hosting | Vercel") is the entirety of it

The spine binds itself to "SRS 11.1-11.7 production roadmap" (frontmatter `binds`), which is dominated by the Supabase auth+persistence cutover — the biggest architectural event ahead of this brownfield codebase. Yet the spine says nothing about:

- Environments (dev/staging/prod) and how they map to Supabase projects
- Supabase organisation/project ownership
- Migration mechanics (forward-only migration tooling, how/when applied, who runs them)
- RLS-policy authoring, review, or test strategy (`docs/ARCHITECTURE.md`'s own production target table calls out "Add RLS/policy tests and integration tests against a real database" as a verification-layer change — the spine's Stack table lists Vitest/Playwright versions but never engages with this)
- Secrets/env-var strategy across the `DEMO_SESSION_SECRET` → Supabase Auth cutover
- Whether the cutover is big-bang or staged/feature-flagged
- Whether Vercel + Supabase remains the target post-demo stack at all

`docs/ARCHITECTURE.md`'s own "Open decisions" section already names three of these explicitly: *"Supabase organisation/project ownership and environments,"* *"Retention periods and authorised production operators,"* and *"Whether deployment remains Vercel/Supabase after the demonstration."* The spine's Deferred section carries forward the retention item (folded into "Gating configuration decisions") but drops the other two entirely — they aren't Decided, Deferred, or listed as an Open Question anywhere in the spine. A whole dimension the initiative altitude owns is left completely silent, not merely under-specified.

---

## High

### H-1. No AD specifies a mechanical enforcement mechanism — every Rule relies on prose discipline

AD-1 through AD-6 are all written as "never do X" / "always do Y" prose rules (e.g., AD-1: "never a direct import of fixture data or a database client from domain code or a server action"). None of them pairs the rule with an enforcement mechanism — a lint import-boundary rule (e.g. `eslint-plugin-boundaries` / `no-restricted-imports`), an architecture test, or a CI check. In a brownfield codebase where independently-built stories will each touch `src/server/*-store.ts` and `src/server/*-actions.ts`, nothing mechanically stops a new story from repeating exactly the `auth.ts` violation AD-1 itself flags as already having happened once. This is the specific failure mode the spine altitude exists to close off for independently-built units, and it's left to code review alone.

### H-2. Deferred item on Staff-vs-Administrator interview/training edit rights drops the PRD's own interim default, leaving a real divergence path open

The spine's Deferred bullet — *"Staff-side interview/training editing vs. SRS 11.3's Administrator edit-rights over the same fields — needs closer field-level reconciliation at the epics/stories stage"* — mirrors PRD §8 Open Question 2, but drops the interim default the PRD already states for half of this: FR-2's Out of Scope note says *"Administrator editing or deleting a Staff-authored interview entry — not specified; treat as read-only for Administrators unless confirmed otherwise."* Nothing in the spine's ADs or Consistency Conventions encodes "Administrator writes to Staff-authored interview/training fields are disallowed until reconciled." Two independently-built units — the FR-2 staff-editing story and a future SRS-11.3 admin-editable-records story touching the same fields — have no rule stopping them from landing on incompatible answers (e.g., one adds an Admin "edit interview" action, the other assumes it can't exist). This is exactly the kind of Deferred-item risk the checklist asks to catch.

---

## Medium

### M-1. Dangling cross-reference in the Stack table: Next.js version note points at a Deferred entry that doesn't exist

The Stack table's Next.js row reads: *"15.5.0 (installed; current is 16.3.x, 15.x is Maintenance LTS not deprecated — see Deferred)."* The Deferred section has seven bullets (LMS mechanics, Central R&D manager, additional departments, staff-vs-admin editing, SRS correction, gating configuration, colour-contrast) and none of them is about Next.js versioning or an LTS/upgrade decision. This is an internal-consistency defect in precisely the area the checklist asks to be sanity-checked — a reader following the pointer finds nothing.

### M-2. `audit_events` — part of the very persistence migration this spine binds to — is absent from the ERD, Deferred, and everywhere else

`docs/ARCHITECTURE.md`'s "Target entities" table (the production schema this spine's SRS-11.1/11.2 row is supposed to govern) includes an append-only `audit_events` entity for actor/target/action/metadata tracking. The PRD explicitly counter-metrics on unauthorized-access incidents (SM-C1) and inherits `NFR-SEC-004`'s access-control gate. The spine's ERD (Employee/Account/Department/Assignment/AssignmentEvaluation/BackfilledProjectEntry/ExternalInterview/TrainingEnrolment/TimesheetEntry) never mentions audit logging, and it isn't in Deferred or Open Questions either — it's simply not addressed, despite being both an existing-doc commitment and a security-relevant one.

### M-3. Zod input validation is "earmarked" but never made a Rule or Convention — divergence risk across every new server action

The Stack table notes zod 4.1.0 is "installed, unused anywhere in `src/` today — earmarked for server-action input validation once persistence lands." The spine is about to add six new server-action modules (`interviews-actions.ts`, `assignments-store.ts`, `assignment-evaluations-store.ts`, `backfilled-project-store.ts`, `departments-store.ts`, `training-store.ts`, `lms-client.ts`), all independently buildable per the Capability Map. Without a Consistency Convention (or AD) mandating zod schemas at every server-action boundary, some stories may validate input with zod and others with ad hoc checks (or none), for equivalent request shapes — a straightforward, cheap-to-close gap given the library is already installed and named as the intended tool.

---

## Low

### L-1. FR-2's field-immutability pattern (company/role/date locked after creation) has no governing convention

FR-2's testable consequence — some fields become immutable post-creation while others stay editable — is a pattern likely to recur (it foreshadows `Assignment`'s FR-7 consequence that "Client, project name, Department, allocation, and dates remain exactly as set by FR-6"). The spine's Consistency Conventions table doesn't name this as a recurring shape, so it's implicitly left to per-entity story design rather than stated once. Not a hard divergence risk since it's single-entity scoped today, but worth a one-line convention entry given it will likely recur.

### L-2. No convention carrying forward the existing test-layout pattern for new modules

`docs/ARCHITECTURE.md`'s Test Layout section shows a strict one-test-file-per-source-module convention (`tests/leave.test.ts`, `tests/auth.test.ts`, `tests/csv.test.ts`, etc.) that is clearly a deliberate, enforced-by-CI pattern (`.github/workflows/ci.yml` runs the full suite on every PR). The spine's Structural Seed lists seven new `src/server/*` modules and one new `src/domain/departments.ts` module but never states that each gets a matching `tests/*.test.ts`, leaving this brownfield convention to be picked up (or not) per-story by convention alone rather than by stated Rule.

---

## Positive Notes (not findings)

- AD-1 through AD-6 are each correctly bound to specific FR/SRS references and each states a plausible, specific divergence it prevents — the mechanism, not just the intent, is described (e.g., AD-4's parent-chain walk, AD-2's three-table split).
- The spine correctly identifies and calls out the one pre-existing brownfield violation (`auth.ts`'s direct `import { employees }`) rather than silently ratifying it — a genuine ratify-with-correction, not a contradiction.
- The Capability → Architecture Map covers all ten PRD FRs plus the SRS 11.1/11.2 identity/persistence row, each mapped to a specific store/file and a governing AD — no PRD capability is dropped.
- The paradigm section (horizontal layers, not per-feature folders) is a direct, correctly-cited match to the existing `leave.ts`/`timesheet.ts`/`AttendanceStore` structure in `docs/ARCHITECTURE.md`, not an invented pattern.
