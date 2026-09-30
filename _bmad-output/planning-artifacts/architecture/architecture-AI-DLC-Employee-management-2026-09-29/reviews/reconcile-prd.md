---
title: PRD → Architecture Spine Reconciliation
sources:
  - prd: '_bmad-output/planning-artifacts/prds/prd-AI-DLC-Employee-management-2026-09-25/prd.md'
  - spine: '_bmad-output/planning-artifacts/architecture/architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md'
created: '2026-09-30'
purpose: 'Check for PRD content that quietly did not land in the architecture spine'
---

# PRD → Spine Reconciliation

## 1. FR-1..FR-10 coverage in the Capability → Architecture Map

Structurally, every FR has a row in the Map (FR-1..3, 4, 5, 6, 7, 8, 9, 10 all present). Checking each row's governing AD against the FR's actual PRD-stated consequences, not just plausibility:

| FR | Map row | Verdict |
| --- | --- | --- |
| FR-1 (Staff adds interview) | AD-1, AD-7, Consistency Conventions | **Match.** Session-derived employeeId (AD-1) + zod validation (AD-7) + ownership convention table row cover FR-1's two testable consequences directly. |
| FR-2 (Staff edits interview) | AD-1, AD-7, Consistency Conventions | **Match.** "Field immutability" convention row names FR-2's company/role/date-lock-after-creation behavior verbatim. Author-only edit covered by AD-1 scoping. |
| FR-3 (interview visibility: Admin + reporting employee only) | AD-1 (via FR-9's shared row, "store-layer query scoping") | **Thin.** AD-1's actual rule text ("a store never serves a different employeeId than the one its calling server action scoped it to") is written for the same-actor-owns-own-record case. It does not itself state the Administrator-sees-all / Staff-sees-own-only split, nor that one Staff session can never be granted another employeeId's data. Plausible-sounding fit, but the specific cross-role visibility rule FR-3/FR-9 require is never named as an enforced rule anywhere in the spine — only inferred from the general scoping clause. |
| FR-4 (LMS current enrolments) | AD-3 | **Match.** AD-3's `listCurrentEnrolments` contract, `LmsUnavailableError`/`stale` fields map directly to FR-4's "clear stale/unavailable state" consequence and retire NFR-REL-001 as the PRD instructs. |
| FR-5 (training history) | AD-1, AD-3 | **Match.** `training-store.ts` as sole caller of `lms-client.ts` and sole repository of record covers FR-5's "fixture/legacy entries display alongside LMS-synced entries" consequence. |
| FR-6 (Assignment create/close, history not overwrite) | AD-1, AD-2 | **Partial gap.** AD-2 correctly assigns sole write-authority over `status`/`completionDate` to `assignments-store.ts` and (via AD-1's example clause) the closed-Assignment-before-Evaluation invariant. But FR-6's other testable consequence — "at most one open (current) Assignment" per employee — has no named governing rule anywhere. AD-1's cross-entity-invariant clause gives only "no Evaluation on a non-closed Assignment" as its worked example; a second open Assignment being created while one is already open is never called out as store-layer-enforced. |
| FR-7 (Assignment Evaluation, Dept Manager authorization) | AD-2, AD-4 | **Match** — see §2 below for detailed check. |
| FR-8 (Backfilled Project Entry) | AD-1, AD-2 | **Match.** AD-2's mandatory materialized `provenance` field matches FR-8's "distinguishable... e.g. a provenance flag" consequence; AD-1 covers the own-entries-only ownership rule. |
| FR-9 (visibility rules) | AD-1 | **Thin**, same issue as FR-3 — see above. |
| FR-10 (department list management) | AD-4, AD-5 | **Partial gap.** AD-5 covers the parent/cycle-rejection consequence well. AD-4 is listed presumably because FR-10 manager reassignment feeds AD-4's authority chain — reasonable to cross-reference, but FR-10's own testable consequence "every Assignment/BackfilledProjectEntry references a Department that exists in the Administrator-managed list at creation time" (a referential-integrity rule) is not owned by either AD-4 or AD-5, and isn't named in AD-1 either. |

## 2. AD-4 vs. PRD Glossary "Department Manager" + FR-7 consequences

**No material gap found.** AD-4's rule — "the Assignment's Department's own manager, plus every ancestor Department's manager, plus every Administrator-role account, unconditionally... 'up to and including the Administrator' is a permanent floor of authority, not a fallback that stops applying once every level in the chain has its own manager" — matches the Glossary's "authority flows down the Department hierarchy... a manager's manager retains authority over what's below them, they aren't replaced by a more specific manager being assigned" precisely, including the non-obvious "not a fallback" framing.

The PRD's confirmed direction that a future subordinate Department Manager (Central R&D's) gets **narrower, department-scoped rights, not full Administrator authority** (Glossary, Open Question 4, Assumptions Index) is correctly *not* asserted as resolved by AD-4 — AD-4 only defines the FR-7 write-authorization mechanism (which is fully specified), and the spine's Deferred section explicitly states "the actual second account and what it can/can't do beyond FR-7 is undefined until it's real." This is the right amount of commitment: it doesn't quietly grant the future subordinate manager Administrator-equivalent rights, and it doesn't pretend the narrower-rights shape is designed yet.

One elaboration beyond the PRD, worth flagging as an addition rather than a gap: AD-4 states any authorized account may *amend* an existing Evaluation (not just create one), with amendment not restricted to the original author. The PRD's FR-7 consequences never state whether evaluations are amendable or by whom — this is the spine filling an unaddressed question, not contradicting one. Not a landing gap, but worth the PM's attention since it's a new access-control decision the PRD never surfaced for confirmation.

## 3. Non-Goals (§5) vs. AD-4's audit/authorship tracking

**No gap found — correctly scoped.** AD-4's `authoredBy`/`updatedAt` fields track which *manager account* wrote or amended an Evaluation — an accountability record of managers' actions, not a scoring mechanism applied to the employee. The separate `AuditEvent` entity (tied to SM-C1/NFR-SEC-004) is scoped to "security-relevant changes," per its Capability → Architecture Map row, not to employee performance data. Evaluations themselves remain single, manual, per-Assignment write-ups exactly as PRD §5 requires ("evaluates one piece of work, not the person... stays fully manual"). Nothing in the spine aggregates Evaluations into a score, trend, or ranking. The Non-Goal is respected.

## 4. Success Metrics (§7) support in the spine

**This is the clearest gap.** Of the PRD's four Success Metrics:

- **SM-1** (% of readiness reviews conducted through the workspace vs. prior scattered method) — **not mentioned anywhere in the spine.** No instrumentation, event capture, or query path is named for it.
- **SM-2** (time for L&D manager to answer "is employee X ready for role Y") — **not mentioned anywhere in the spine.**
- **SM-3** (% of closed Assignments evaluated within expected turnaround; % of employee-authored records kept current) — **not mentioned anywhere in the spine.** Given AD-4 already tracks `authoredBy`/`updatedAt` on Evaluations, SM-3's turnaround half is only one query away from being supportable — but the spine never draws that connection or reserves the field for it.
- **SM-C1** (zero unauthorized-access incidents; the one counter-metric the PRD is most emphatic about, given it directly counterbalances SM-1's "move fast" pressure) — gets exactly one line in the spine: a Capability → Architecture Map row pointing to `AuditEvent`. But `AuditEvent`'s own entry in the Deferred section says "its exact shape, who writes it, and how it's queried are undecided." So the one Success Metric the spine explicitly claims to support is backed by a named-but-undesigned placeholder, not a concrete mechanism.

Net: Success Metrics support in the spine is **asserted, not built** — three of four metrics have zero architectural footprint, and the fourth's footprint is a deferred stub.

## Summary of gaps

1. **Success Metrics are essentially unsupported.** SM-1/SM-2/SM-3 have no architectural grounding anywhere in the spine; SM-C1's sole support (`AuditEvent`) is itself listed as undecided in Deferred. The PRD's most security-sensitive counter-metric currently rests on a name, not a design.
2. **FR-6's "at most one open Assignment per employee" invariant is never named as an enforced rule** — AD-1/AD-2 cover the adjacent "no Evaluation on non-closed Assignment" and "sole writer of status/completionDate" rules but skip this one.
3. **FR-3/FR-9's Administrator-sees-all / Staff-sees-own-only visibility rule is only thinly implied by AD-1**, which is written for the same-actor-scoping case, not explicitly for the cross-role visibility split FR-3/FR-9 require.
4. **FR-10's referential-integrity consequence** (Assignment/BackfilledProjectEntry must reference a Department that exists in the managed list at creation time) isn't owned by either AD listed for FR-10 (AD-4, AD-5) or named in AD-1.

Not gaps (checked and found sound): AD-4's match to the Glossary's Department Manager / authority-flows-down model and FR-7's write-authorization consequences; the spine's restraint against over-building AD-4 into a performance-scoring mechanism per PRD §5 Non-Goals.
