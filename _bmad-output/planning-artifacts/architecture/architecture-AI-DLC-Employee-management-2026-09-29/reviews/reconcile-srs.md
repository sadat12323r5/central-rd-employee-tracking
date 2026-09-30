# Reconciliation: SRS.md → ARCHITECTURE-SPINE.md

**Purpose:** Check the spine's AD structure against `docs/SRS.md` for anything that quietly didn't land — a requirement, constraint, or framing dropped in translation. The spine's frontmatter (`binds: [..., 'SRS 11.1-11.7 production roadmap']`) claims to cover all of SRS Section 11; this checks that claim item by item, plus Section 1's framing and Section 7's NFRs.

## Method

Read `docs/SRS.md` in full (Sections 1–12) and `ARCHITECTURE-SPINE.md` in full. Extracted every SRS §11 sub-requirement and every §7 NFR, then grepped the spine for corresponding AD/Capability-Map/Deferred coverage.

## Section 11 coverage, item by item

| SRS item | Spine coverage | Verdict |
|---|---|---|
| **11.1 Identity/roles** — named Supabase accounts, Admin + Standard User/employee roles, no self-registration, **deactivation denies sessions on next request while preserving history** | AD-6 (account creation funnels through one repo method, no self-registration), Consistency Conventions (session discriminated union by role), Capability Map row. **Deactivation behavior is not mentioned anywhere** — no AD, no Deferred item. | **Partial gap** |
| **11.2 Persistence/integrity** — Supabase Postgres, forward-only migrations, **DB uniqueness constraints on Employee ID/primary email/skill-training-interview identifiers**, RLS as final boundary, dual API+DB authorization | AD-1 (repo interfaces, store-layer invariant enforcement as forerunner to DB constraint), Deployment & Environments Deferred (migrations, RLS policy/test strategy explicitly named as undecided — not silently dropped). AD-2 only calls out uniqueness for `AssignmentEvaluation` (1:1). **The SRS-specified uniqueness set (Employee ID, email, skill/training/interview identifiers) is never named.** | **Partial gap** |
| **11.3 Editable records** — create/update workflows, server-side validation, **immutable audit event in the same transaction** for security-relevant changes | AD-7 (zod validation on every server action), Field Immutability convention, `AuditEvent` named in ERD + Capability Map (tied to NFR-SEC-004/SM-C1). Exact schema/write path/same-transaction guarantee explicitly listed in Deferred (not silently dropped). | Covered (open items are named, not hidden) |
| **11.4 Leave workflow** — wire `src/domain/leave.ts` into create/edit with recalculation, same-employee overlap rejection, holiday calendar with supported year range, existing category labels/colours | **No AD addresses this. No `leave-store.ts`/`leave-actions.ts` in the Structural Seed (unlike every other FR, which gets a NEW store/action file). No Capability Map row. No Deferred entry.** The only mentions of `leave.ts` in the whole spine are two passing references to it as an existing pure-function example (paradigm section, departments.ts analogy) — not as a capability being architected. | **Gap — full subsection dropped** |
| **11.5 Config decisions** — org timezone, holiday calendar (jurisdiction/years/version), retention periods, System-Owner-approved before real data loads | Deferred: "Gating configuration decisions (org timezone, holiday calendar, retention periods) — System Owner approvals, non-technical, outside this spine's scope (PRD §4.7)." | Covered (explicitly deferred, not silent) |
| **11.6 Explicitly out of scope** — GitHub/Git-provider integration, plain-text logbooks, payroll, leave balances/approvals, automated productivity/performance score | Nothing in the spine's ADs reintroduces any of these. AD-2/AD-4's `AssignmentEvaluation` is manager-authored narrative (per PRD glossary: "written account... plus optional client feedback"), not automated or activity-derived — consistent with the out-of-scope boundary. | No gap |
| **11.7 Colour-contrast** | Deferred: "Colour-contrast remediation — independent CSS/token work, no architectural dependency (PRD §4.8)." | Covered |

## Section 1 framing check (not payroll/medical/surveillance/performance-scoring)

The spine's AD-2 introduces `AssignmentEvaluation` as new architecture. This is the one place new data closest to "performance scoring" enters. Checked against PRD source (`prd.md` §3 Glossary, §4.1 Notes, FR-7): the PRD already explicitly settles this — "FR-7's Assignment Evaluation is a per-project sibling of [the profile's] existing 'most recent manager evaluation' (SRS FR-PROF-005) — the product already holds Administrator-authored evaluations of an employee's work today; FR-7 doesn't introduce a new category of data, just a per-Assignment one." AD-2 is consistent with this (narrative record, single writer, no score field, no automated derivation from activity). **No gap** — the spine correctly inherits the PRD's settled framing rather than needing to re-litigate it, and doesn't smuggle in anything resembling an automated score.

## Stale single-actor claim (SRS §2/§3.1)

Spine's Deferred section: "`docs/SRS.md` §2/§3.1's stale actor-model correction — applied directly to the source document at this run's Close step (see PRD Document Purpose), not modeled as an architectural decision itself." This correctly identifies the staleness and correctly declines to model it as an AD (it's a documentation fix, not an architecture decision) while still tracking it as an open item. **No gap.**

## Section 7 NFRs touched by persistence/integration decisions but not mentioned

- **NFR-REL-001** ("no failure mode where partial data loads, because there is no external data source") is the one NFR whose stated premise is *directly invalidated* by the spine's own architecture: AD-3 introduces a real external dependency (`lms-client.ts`, with a defined `LmsUnavailableError` / `stale: true` failure contract) and AD-1/Deployment & Environments move persistence to Supabase (a networked DB, with its own partial-failure modes). **The spine never names NFR-REL-001, never states that it is being superseded, and never specifies a UI-level reliability contract (retry, degrade, error surfacing) for the new failure modes it just introduced at the store/adapter layer.** AD-3 stops at the server-layer contract (`stale`/throw) — nothing carries that through to what the calling UI/NFR guarantee becomes. This is the clearest NFR-level gap.
- NFR-SEC-002 (secrets never hard-coded) — covered via Deployment's "Secrets/env-var strategy across the DEMO_SESSION_SECRET → Supabase Auth cutover" (named as deferred, not dropped).
- NFR-SEC-004 (single-credential exposure ban) — explicitly tied to the Capability Map and `AuditEvent`/SM-C1 row. Covered.
- NFR-UX-004 (accessibility) — covered via 11.7 handling above.

## Summary of gaps found

1. **SRS 11.4 (leave workflow) is absent from the spine entirely** — no AD, no store/action file in the Structural Seed, no Capability Map row, no Deferred acknowledgment — despite the spine's own frontmatter claiming to bind "SRS 11.1-11.7." This is the most significant finding: a whole numbered roadmap item silently missing rather than explicitly deferred like 11.5/11.7 were.
2. **SRS 11.1's account-deactivation requirement** (deny sessions on next request, preserve history) has no corresponding AD or Deferred entry; AD-6 covers only account *creation*.
3. **SRS 11.2's named uniqueness constraints** (Employee ID, primary email, skill/training/interview identifiers) are not called out anywhere in the spine; only `AssignmentEvaluation`'s 1:1 uniqueness (AD-2) is addressed.
4. **NFR-REL-001** is invalidated by the spine's own AD-3 (LMS adapter) and Supabase persistence move, but is never named or reconciled — no successor reliability contract is stated for the UI/caller side of the new failure modes.

No gaps found in: 11.5, 11.6, 11.7, the Section 1 / AssignmentEvaluation framing check, or the SRS §2/§3.1 stale-actor-model note — all three are either correctly covered or correctly and explicitly deferred rather than silently dropped.
