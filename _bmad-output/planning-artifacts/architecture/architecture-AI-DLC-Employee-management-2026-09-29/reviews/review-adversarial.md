---
title: Adversarial Review — ARCHITECTURE-SPINE.md
reviewer-lens: 'Two-engineers-one-level-down incompatibility attack'
target: architecture-AI-DLC-Employee-management-2026-09-29/ARCHITECTURE-SPINE.md
created: '2026-09-30'
status: draft
---

# Adversarial Review — ARCHITECTURE-SPINE.md

## Method

For each AD, and for the seams between ADs, two engineers are constructed who each build a plausible, letter-compliant implementation independently, without talking to each other. Where their implementations produce incompatible shared-data shapes, dual ownership of one entity, or conflicting mutation paths, that pair is recorded as a finding. Each finding names the exact clause both engineers can honestly point to as their justification — the hole is that the clause doesn't disambiguate between their two readings.

18 findings below, grouped by AD, plus a cross-AD section. Every finding is a hole to close with a new or tightened AD (or an explicit line added to an existing one), not a rejection of the paradigm.

---

## AD-1 — Repository interface for every entity

**F1. Store-layer visibility scoping is unspecified — trust boundary drifts per store.**
AD-1 only requires "a store/repository interface … matching the existing `AttendanceStore` shape." Engineer A's `interviews-store.ts` treats `list(employeeId)` as self-enforcing: it reads the caller's session internally and ignores/rejects a mismatched `employeeId` argument (defense in depth). Engineer B's `assignments-store.ts` treats `list(employeeId)` as a dumb query — it trusts whatever id the caller (server action) passes, since FR-9 says visibility scoping lives at "the store layer" but AD-1 never says the store must re-derive identity rather than accept it as a parameter. A server action that queries both stores through one shared authorization wrapper gets silently different enforcement: A is safe if the action forgets to check the session; B is not.

**F2. No canonical repository error contract — store failure modes diverge.**
AD-1 pins interface *shape* to `AttendanceStore` but not *error semantics*. Engineer A's not-found returns `null`; Engineer B's throws a typed `NotFoundError`. The Consistency Conventions table only standardizes `{error, message}` for **server-action** results, leaving stores unconstrained. A shared error-handling wrapper written against one convention silently swallows or crashes on the other store's failures.

**F3. Cross-entity invariants have no assigned layer, so each engineer enforces them differently.**
Closing an Assignment and creating its Evaluation are cross-entity invariants (AD-2). Engineer A enforces "no evaluation on a non-closed Assignment" inside `assignment-evaluations-store.create()` (store layer). Engineer B enforces the same invariant in `src/domain/assignments.ts` before calling the store (domain layer), reasoning AD-1 keeps stores "dumb" persistence wrappers and business rules belong in domain per the paradigm's own stated split. Under fixture storage both "work" by accident since there's one call path; once Supabase lands (AD-1's own stated future), only the store-layer check becomes a DB-enforceable constraint — the domain-layer version is bypassed by any second caller (a future admin script, a migration, a batch job) that skips the domain function.

---

## AD-2 — Assignment / AssignmentEvaluation / BackfilledProjectEntry split

**F4. [Flagged] Nothing stops evaluation-shaped fields from being added directly to Assignment.**
AD-2 requires `AssignmentEvaluation` to exist as a separate record — it never forbids *additional* nullable fields on `Assignment` itself. Engineer A builds `assignments-store.ts` to FR-6's field list only. Engineer B, building FR-7 first and wanting a place to stash a manager's in-progress evaluation draft before FR-7's own store exists, adds nullable `evaluationNotes`/`clientFeedback` columns directly onto the `Assignment` type "temporarily" — technically satisfying AD-2 (`AssignmentEvaluation` still exists as its own entity for the *final* write) while recreating exactly the ambiguous-provenance table AD-2 exists to prevent. Nothing in AD-2's rule is self-enforcing against this; it describes the target shape, not a prohibition on the source table carrying shadow copies.

**F5. Two stores, two independent writers of `Assignment.status`/`completionDate`.**
AD-2 says Assignment "closing archives, never overwrites." It does not say only `assignments-store.ts` may write Assignment's closed-state fields. Engineer A's `assignments-store.close(id, completionDate)` is the only writer of `status`/`completionDate`. Engineer B's `assignment-evaluations-store.create(assignmentId, evaluation)`, reading AD-2's "attached to a *closed* Assignment" as a precondition it must itself guarantee, defensively force-closes the Assignment (writing `status`/`completionDate`) as a side effect if it isn't already closed. Two stores now mutate the same Assignment fields through different code paths — a manager evaluating a still-open Assignment silently closes it with a completion date nobody chose, and a race between an Administrator's explicit close and a manager's defensive close can leave different completion dates depending on write order.

**F6. The BackfilledProjectEntry provenance flag has no assigned layer.**
AD-2 requires "an explicit provenance flag distinguishing it from an Administrator-authored Assignment wherever an Administrator views history" but doesn't say whether the flag is a literal field on every returned object or an implicit signal of which store/table it came from. Engineer A relies on table identity (a Supabase `UNION` tagged at query time, or simply "it's in the backfilled table" — no per-object field emitted). Engineer B's UI merge code, building the Administrator's unified history view, expects every row object handed to it to already carry `provenance: 'assignment' | 'backfilled'`. Combined: rows silently render unmarked or the merge throws on an undefined field, depending on which engineer's code executes first.

**F7. 1:1 uniqueness on AssignmentEvaluation is enforced by one engineer, assumed-away by the other.**
AD-2 calls AssignmentEvaluation "a separate 1:1 record" but never states where that cardinality constraint lives. Engineer A checks "does an evaluation already exist for this assignmentId?" in application code before insert. Engineer B, anticipating the Stack section's "Supabase tomorrow," assumes a future `UNIQUE(assignmentId)` constraint will enforce it and skips the check. Today's fixture store (Supabase "still unused" per Stack) has no DB constraint, so Engineer B's implementation silently allows duplicate evaluations per Assignment while Engineer A's doesn't — same AD, same binding FR-7, divergent behavior.

---

## AD-3 — LMS stub adapter

**F8. `TrainingProvider`'s failure contract is unspecified — throw vs. sentinel value.**
AD-3 gives one example method signature and says nothing about error semantics. Engineer A's stub throws `LmsUnavailableError` on failure (matching FR-4's "clear stale/unavailable state" requirement, handled by the caller's try/catch). Engineer B's consumer in `training-store.ts` (built for FR-5, explicitly "independent of the live LMS sync" per the PRD) expects `listCurrentEnrolments` to resolve to `null`/`[]` on failure rather than throw, since AD-3's interface sketch gives no error type. When the stub is later swapped for a real, occasionally-flaky adapter, Engineer B's unhandled path crashes where Engineer A's was designed to degrade.

**F9. The interface's return shape (bare array vs. staleness envelope) is independently guessable two ways.**
FR-4 requires surfacing a stale/unavailable state to the UI. AD-3's one-line example (`listCurrentEnrolments(employeeId)`) doesn't show a return type. Engineer A's `lms-client.ts` stub returns `Enrolment[]`. Engineer B, designing to satisfy FR-4's staleness requirement at the interface boundary rather than in the UI, returns `{data: Enrolment[], asOf: string, stale: boolean}`. Whichever one is actually committed to `src/server/lms-client.ts` first, the other engineer's calling code (FR-4's component) is shaped for the wrong contract — and AD-3 gives no canonical signature to adjudicate between them.

---

## AD-4 — Department-manager authorization resolves to a set

**F10. [Flagged] Concurrent writes by two authorized managers: insert-once vs. upsert, both "compliant."**
AD-4 defines *who* is authorized (plural, a set) but says nothing about *what happens when two members of that set write*. Engineer A's `assignment-evaluations-store.create()` is insert-if-not-exists — first authorized writer wins, second gets an error (consistent with AD-2's "1:1 record," read as immutable-once-created). Engineer B's `create()` is an upsert — last authorized writer wins — reasoned from AD-4's own point that the set is plural precisely so a more senior manager can act; if two people can legitimately write, someone must be able to correct a colleague's entry. Once Central R&D gets its own manager (PRD §8 Open Question 4), L&D's manager and Central R&D's manager are both in the authorized set for the same Assignment simultaneously. Depending purely on which store implementation shipped, a second manager's write either errors or silently clobbers the first manager's evaluation with no audit trail either way.

**F11. The authorized set: computed fresh per-request, or cached per-session?**
AD-4 says the set is derived "by walking that Assignment's Department up its `parent_department_id` chain" — it doesn't say when. Engineer A's write-check re-derives the set fresh on every submit (query-time). Engineer B, following the Consistency Conventions' "session shape stays a discriminated union by role," computes the authorized department-id set once at login and caches it in the session token, checking writes against the cached set. When FR-10 assigns Central R&D its own manager mid-session, Engineer A's check picks it up immediately; Engineer B's implementation either keeps granting a manager who's been superseded, or denies the newly-assigned manager, until they re-authenticate. Both are "walking the Department hierarchy" per AD-4's letter.

**F12. "Up to and including the Administrator" — unconditional union, or gap-fallback only?**
AD-4's phrase "up to and including the Administrator" is read two ways. Engineer A implements it as a fallback: walk the parent chain collecting each level's assigned manager; only union in "any Administrator-role account" if some level in the chain has no manager assigned (a gap-fill). Engineer B implements it as an unconditional union: always add every Administrator-role account to the resolved set, regardless of whether every level already has a real manager, reading AD-4's phrase as a permanent floor of authority rather than a fallback. Once every department in a chain has its own non-Administrator manager (a state the PRD explicitly anticipates — Central R&D's manager will have "narrower rights, not full Administrator authority"), Engineer A's set excludes the Administrator; Engineer B's still includes them. Same Assignment, different authorized sets, both defensible from AD-4's prose.

---

## AD-5 — Self-referencing Department hierarchy

**F13. [Flagged] Nothing in AD-5 requires cycle prevention, and the two layers that could enforce it don't agree on which one does.**
AD-5 states the field exists (`parent_department_id`, optional self-reference) and that Administrators manage it via FR-10. It says nothing about acyclicity. Engineer A's `departments-store.ts` `update()` performs no cycle check — it trusts the FR-10 UI to prevent it. Engineer B's `src/domain/departments.ts` (the pure resolver the Structural Seed names explicitly for "Department hierarchy/authority-chain resolution," per AD-4) walks `parent_department_id` to termination assuming a DAG, with no visited-set guard, because a domain module is supposed to be "pure" and a defensive cycle guard felt like defensive-store-layer work, not domain logic. If Engineer A's store ever persists `A → B → A` (a two-click Administrator mistake in FR-10's UI, nothing rejects it), Engineer B's chain-walk hangs or stack-overflows — and this is the exact code path that gates every `AssignmentEvaluation` write under AD-4. Both engineers are fully AD-5-compliant; together they ship a live-production DoS one fat-fingered parent assignment away.

**F14. Even with a cycle check, its layer placement produces two different failure behaviors.**
Suppose both engineers add *some* guard: Engineer A puts it in the store (`update()` rejects a write that would create a cycle — hard failure at write time). Engineer B puts it in the domain resolver instead (caps traversal depth / detects a revisited id and truncates the chain there — soft degradation at read time). If only A's store guard ships, a cycle written through any path that bypasses `departments-store.update()` (a seed script, a future direct-Supabase admin tool once AD-1's fixture-to-Supabase swap lands) is never caught, and only B's absent read-time guard would have caught it. If only B's ships, cycles can still be *written* freely; every authorization resolution against one silently truncates instead of erroring, masking the underlying data corruption. AD-5 assigns cycle-safety to neither named layer, so there's no way to tell, from the spine alone, which "compliant" implementation a reviewer should trust.

---

## AD-6 — No self-registration

**F15. Two account-creation code paths, only one of which is a deliberate "provisioning" flow.**
AD-6 bars *public self-registration*; it does not say account creation must funnel through one path. Engineer A builds `POST /api/admin/accounts` — the deliberate provisioning endpoint, Administrator-gated, requiring role and credential setup explicitly. Engineer B, building FR-10's "assign a manager" UI, finds that the selected Employee sometimes has no Account record yet, and adds an auto-create-on-assign side effect inside the department-manager-assignment action — still Administrator-triggered, still AD-6-compliant by the letter ("no *self*-registration," this is admin-initiated). The two paths now construct Accounts with different invariants (A's endpoint forces an explicit role and initial credential; B's side-effect path defaults or omits them), so which flow provisioned a given account determines whether it's actually usable — and AD-6 gives no signal that account creation should be single-pathed.

---

## Cross-AD seams

**F16. AD-2 + AD-4: no field records *which* authorized manager actually wrote an evaluation.**
AD-2 says AssignmentEvaluation is "authored by whichever account resolves via AD-4's Department-manager chain" but doesn't require storing that account's id on the record. The Consistency Conventions table only calls out `employeeId` ownership from session, and that line is naturally read as being about the record's *subject* (the employee being evaluated), not its *author*. Engineer A adds `authoredBy: session.accountId` to the evaluation, extrapolating the ownership convention to authorship. Engineer B treats AD-4's authorization check as the entire job and persists no author field — the check happens, then it's forgotten. Once Central R&D's manager exists alongside L&D's (both in one Assignment's authorized set, F10/F12), Engineer B's schema makes it structurally impossible to answer "which manager wrote this evaluation" — undermining the accountability the multi-manager set was presumably meant to support, and neither AD-2 nor the Consistency Conventions table makes the field mandatory.

**F17. AD-1's session-ownership convention is ambiguous for a record whose author and subject are different people.**
The Consistency Conventions row says ownership is "always taken from the signed session, never the submitted form" — written for Attendance/Assignment, where actor and subject are the same person. AssignmentEvaluation breaks that assumption: the author is the manager (session), the subject (`employeeId`) belongs to the Assignment being evaluated. Engineer A correctly derives `employeeId` from the looked-up Assignment record (via the submitted `assignmentId`), not the acting manager's session. Engineer B applies the convention literally — "ownership's employeeId comes from the session" — and sets `employeeId` to the *manager's own* session id, since that's the only session-derived value available at write time, letter-compliant with a rule that was never written with this entity's actor/subject split in mind. B's evaluations get attributed to the wrong employee.

**F18. AD-3 + AD-1: is `lms-client.ts` itself a repository, or an exempt external adapter — two valid call paths to the same data.**
AD-1 binds "all persistence access"; LMS enrolment data is a live external read, not Brain Station's own persisted data, so it's plausibly exempt. Engineer A treats `lms-client.ts` as its own AD-3-governed boundary, calling it directly from a server action for FR-4's "current enrolments" view. Engineer B, building `training-store.ts` for FR-5 (which must merge LMS-synced entries with historical fixture/DB entries "alongside" each other per FR-5's own consequence), decides `training-store.ts` is the single AD-1 repository of record for *all* TrainingEnrolment reads, wrapping `lms-client` calls internally and never exposing it directly — consistent with AD-1's "never a direct import … from a server action." Two valid call paths to the same underlying LMS stub now coexist: a UI built against A's direct path bypasses B's history-merge and staleness logic entirely, and if both paths are hit on the same page, they can independently report different staleness/`asOf` states for the same employee's enrolments.

---

## Summary table

| # | AD(s) | Incompatibility |
| --- | --- | --- |
| F1 | AD-1 | Store-layer visibility scoping: self-enforcing vs. caller-trusting |
| F2 | AD-1 | No canonical store error contract (null vs. thrown error) |
| F3 | AD-1, AD-2 | Cross-entity invariant enforced in store vs. domain layer |
| F4 | AD-2 | Evaluation-shaped fields added directly onto Assignment |
| F5 | AD-2 | Two stores both write Assignment's closed-state fields |
| F6 | AD-2 | Provenance flag: implicit (table identity) vs. explicit (per-object field) |
| F7 | AD-2 | 1:1 uniqueness enforced in app code vs. assumed at future DB layer |
| F8 | AD-3 | LMS adapter failure contract: throw vs. sentinel |
| F9 | AD-3 | LMS adapter return shape: bare array vs. staleness envelope |
| F10 | AD-4 | Concurrent evaluation writes: insert-once vs. upsert |
| F11 | AD-4 | Authorized set: per-request vs. per-session-cached |
| F12 | AD-4 | "Administrator" inclusion: gap-fallback vs. unconditional union |
| F13 | AD-5 | No cycle prevention on `parent_department_id`; neither layer owns it |
| F14 | AD-5 | Cycle-guard layer mismatch: hard reject at write vs. soft truncate at read |
| F15 | AD-6 | Two divergent account-creation code paths, both "admin-initiated" |
| F16 | AD-2, AD-4 | No field records which authorized manager authored an evaluation |
| F17 | AD-1, AD-2 | Session-ownership convention misapplied when author ≠ subject |
| F18 | AD-1, AD-3 | Two valid call paths to LMS data — one bypasses the history-merge layer |

**Total: 18 findings.**

## Suggested closes (by finding)

- F1, F2, F3 → tighten AD-1 with an explicit sub-rule: stores re-derive identity from session (never trust a passed id for scoping), a single canonical not-found/error contract, and a named layer (store, not domain) for cross-entity invariants that will become DB constraints.
- F4, F5, F6, F7 → tighten AD-2: forbid evaluation-shaped fields on Assignment explicitly; name `assignments-store.ts` as sole writer of Assignment's status/completionDate; require the provenance flag to be materialized as a literal field by the store, not inferred from table identity; state where 1:1 uniqueness is enforced today (app-layer, since Supabase is unused).
- F8, F9 → tighten AD-3 with a concrete `TrainingProvider` return/error contract, not just a method name.
- F10, F11, F12 → new AD (or AD-4 amendment) specifically for concurrent-write resolution within an authorized set: pick insert-once-then-immutable vs. versioned/upsert-with-audit, state whether the set is session-cached or per-request, and disambiguate "the Administrator" as a role-check vs. a single designated account once multiple Administrator accounts can exist (AD-6 permits this).
- F13, F14 → new AD requiring cycle rejection at write time in `departments-store.ts`, named explicitly, with the domain resolver's traversal treated as a second, non-load-bearing safety net, not the primary guard.
- F15 → tighten AD-6 to require all account creation — including side effects of other admin actions — to funnel through one repository method.
- F16, F17 → tighten the Consistency Conventions ownership row to distinguish "subject" from "author" fields, and require AssignmentEvaluation to persist `authoredBy`.
- F18 → clarify AD-1/AD-3 boundary: `lms-client.ts` is never called directly outside `training-store.ts`; make `training-store.ts` the sole AD-1 repository for all TrainingEnrolment data, current and historical.
