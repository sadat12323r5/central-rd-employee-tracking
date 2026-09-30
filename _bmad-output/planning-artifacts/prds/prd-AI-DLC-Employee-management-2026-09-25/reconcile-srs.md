# Reconciliation: PRD vs. `docs/SRS.md`

**Source (source of truth being checked against):** `docs/SRS.md` v0.3, "implementation baseline," 24 Sep 2026
**Target (drafted PRD):** `prd.md`, this folder, created 2026-09-25 / updated 2026-09-29
**Scope of this check:** faithfulness of the PRD's carry-forward of the SRS — dropped requirements, misrepresented scope, missing NFR concerns, and dropped qualitative/tone intent. Not re-litigating FR-DIR-*/FR-PROF-* line items, which the PRD correctly references by pointer rather than re-specifying.

---

## Verdict

Mostly faithful, well-structured, and the PRD is honest about its own assumptions ([ASSUMPTION] tags, Open Questions). One finding is significant enough to flag before this PRD is used as the new source-of-truth; the rest are smaller framing/completeness gaps.

---

## Findings

### 1. (Significant) PRD asserts "Staff Attendance — shipped" in direct contradiction of the SRS's stated actor model, without flagging the contradiction

SRS §2 (Stakeholders) states as fact, today: *"Employee (subject of records) | ... | No account; not a system actor."* SRS §3.1 ("In scope today") and §3.2 ("Out of scope today") list nothing resembling employee self-service, a second session role, or clock-in/out — §3.2 explicitly lists "Real user accounts: there is exactly one shared demo credential, not tied to an individual." SRS §11.1 treats a Staff/employee account role as **production roadmap, not yet implemented**.

PRD §4.2 nonetheless describes "Staff Attendance *(shipped)*" as current reality: a `staff` session role scoped to one `employeeId`, clock in/out in Dhaka time, work mode, breaks, daily task log — backed by cited files `src/domain/timesheet.ts`, `src/server/attendance-actions.ts`, `src/components/staff-attendance.tsx`. I verified these files exist in the repo, so the PRD's factual claim about the codebase appears correct — but that means **the SRS itself is stale on a foundational point (the single-actor model)**, and the PRD never says so. The closest it comes is a parenthetical in the Glossary ("Shipped for attendance only") and §2.2 ("this PRD's Staff role is new, shipped so far only for attendance") — neither of which tells a reader that this directly contradicts the document the PRD names as its authoritative predecessor.

**Why it matters:** the PRD states in §0 that `docs/SRS.md` "remain[s] the engineering-detail record of what is actually implemented" and should be reconciled against the PRD by `bmad-architecture`. If the SRS is wrong about something as basic as "there is exactly one actor today," that's not a detail to leave implicit — it should be called out explicitly (e.g., in §0 or as a flagged assumption in §9) so `bmad-architecture` and the SRS's own maintainers know the SRS needs a v0.4 correction, not just an extension.

**Recommendation:** Add an explicit note (§0 or a new §9 entry) stating that SRS §2/§3.1 do not reflect the already-shipped Staff attendance role, and that SRS is due for a correction, not just future-roadmap additions.

### 2. Dropped qualitative "what this is not" framing (surveillance/medical)

SRS §1 states explicitly: *"It is not a payroll, leave-entitlement, medical, surveillance, or automated performance-scoring system. Recorded Git activity is a sample metric, never a productivity score."* This is a deliberate trust-building statement, not a scope list — it preempts an obvious employee concern ("is this monitoring me?").

PRD §5 (Non-Goals) carries forward payroll/leave and automated performance-scoring, but drops "medical" and, notably, **"surveillance"** entirely. This omission is more consequential than it looks because the PRD's own new scope (§4.3 — staff self-reporting interviews, training, project/client outcomes) is exactly the kind of feature that invites an employee to ask "is my manager watching me for this?" Carrying forward the SRS's explicit non-surveillance framing would have been the natural place to reassure that intent hasn't shifted.

**Recommendation:** Restate the SRS's "not surveillance / not medical" framing in §5 Non-Goals, ideally tied explicitly to the new self-service data being collected in §4.3.

### 3. "System owner" governance actor dropped

SRS §2 distinguishes **System owner** (Brain Station 23's L&D manager — approves scope, provisioning, and, in production, data retention) from **Administrator** (the operational actor who reviews records day to day). SRS §11.5 makes this concrete: retention periods are "release-blocking... approved by the system owner before any real data is loaded."

PRD §2.1 collapses these into one line — "L&D Manager (Administrator)" — and never reintroduces a governance/approval actor. §4.7 (Gating Configuration Decisions) lists timezone/holiday-calendar/retention as blocking approvals but doesn't say *who* approves them. This is a minor loss of accountability clarity, most relevant to whoever scopes the approval workflow later.

**Recommendation:** Either explicitly state in §2 or §4.7 that the System Owner = the L&D manager acting in an approval capacity (distinct from their day-to-day Administrator use), or note the SRS's owner/administrator split was intentionally simplified.

### 4. Developer/operator actor and NFR pointers not carried forward

SRS §2 also names a Developer/operator actor (repo/deploy access today; migration + backup authority in production). The PRD never mentions this actor, even though §4.4 discusses Supabase persistence and migrations. Likely fine to omit at PM level, but worth a one-line acknowledgment since backup/migration ownership becomes operationally real once §4.4 ships.

Separately: PRD §4.1 explicitly points to "`docs/SRS.md` §5.1–5.5 ... not re-specified here" for FRs, but there is **no equivalent pointer anywhere in the PRD to SRS §7 (NFR-SEC-*, NFR-REL-001, NFR-UX-001–003)** for the current prototype. Accessibility gets a roadmap item (§4.8, correctly mapped to SRS §11.7 for the *known* colour-contrast gap), but the *already-met* baseline NFRs (keyboard operability, constant-time credential check, secrets never hardcoded, unambiguous date format, no-partial-load reliability) are never referenced at all — a reader of the PRD alone wouldn't know they exist or are already satisfied. This is a smaller version of the same "FRs get a pointer, NFRs don't" gap.

Relatedly, SRS NFR-REL-001 ("no failure mode where partial data loads, because there is no external data source") is quietly invalidated by the PRD's own FR-14 (BrainStation LMS sync introduces exactly that failure mode for the first time). FR-14's own "Consequences" do specify a stale/unavailable state, so the substance is handled — but the PRD never draws the connection to the NFR it is retiring/superseding.

**Recommendation:** Add a short "Non-functional requirements" pointer in §4.1 or §0 mirroring the FR pointer ("current-baseline NFRs — see SRS §7; unchanged except where noted in §4.8 and §4.3/FR-14").

### 5. v0.2 disposition/history omitted (minor)

SRS §12 explains what v0.2 specified (GitHub webhooks, plain-text logbooks, trainee/Senior-Researcher assignment records) and why it was dropped, with explicit guidance to treat v0.2 as a source document to revive if Git-tracking/logbooks become a real requirement again. PRD §5 Non-Goals only carries forward the GitHub/commits piece ("commits figure remains fixture/disclaimer data") — the logbooks and assignment-records disposition, and the "v0.2 is revivable, not deleted" guidance, aren't mentioned. Low priority — this is historical/process context, not active scope — but it is exactly the kind of "why it matters" framing a pure requirements extraction would silently drop.

**Recommendation:** Optional — a one-line footnote in §5 or §12-equivalent noting logbooks/assignment-tracking were deliberately dropped (not overlooked) and are revivable from v0.2 if ever needed.

---

## Not gaps — checked and found faithfully carried

- Core vision/purpose (SRS §1 opening) — carried and appropriately extended in PRD §1.
- Prototype-vs-production framing (SRS §1, §3.3) — carried in PRD §1, §6, §4.4.
- NFR-SEC-004 (no real data under single-shared-credential model) — carried explicitly, including as a counter-metric (PRD §7 SM-C1) and release gate (§4.4, §6.2).
- Production roadmap items (SRS §11.1–11.7) — each has a corresponding PRD §4.4–§4.8 entry with correct SRS section back-references.
- Payroll/leave-balance/leave-approval non-goals, individual rosters/calendars non-goal — carried in PRD §5.
- Colour-contrast known gap (SRS §8, §11.7) — carried faithfully in PRD §4.8 with correct framing as a deliberate, tracked, not-yet-scheduled gap.
- SRS's read-only/no-persistence prototype framing — carried and used as the basis for PRD's MVP scope split (§6).
