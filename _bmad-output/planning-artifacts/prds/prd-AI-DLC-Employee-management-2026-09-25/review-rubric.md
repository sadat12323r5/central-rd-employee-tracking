# PRD Quality Review — L&D Manager Workspace PRD (prd-AI-DLC-Employee-management-2026-09-25)

## Overall verdict

This PRD is unusually disciplined for its size: it separates shipped fact from roadmap intent, tags its own inferences with `[ASSUMPTION]`, and puts real tensions in `[NOTE FOR PM]` callouts rather than smoothing them over. The FR-11–FR-18 block (the PRD's actual payload) is tight, testable, and internally cross-referenced. What's at risk is downstream traceability: the FR numbering starts at FR-11 with no FR-1–10 in this document, a release-gating requirement (NFR-SEC-004) is invoked twice but never stated, and the "MVP Scope" section is really a shipped/roadmap split rather than a minimum-viable-product argument — a decision-maker reading only §6 could mistake "MVP" for something buildable now.

## Decision-readiness — strong

Decisions are stated as decisions, not hedged as considerations: §4.4 says plainly that "neither auth nor persistence alone satisfies" NFR-SEC-004, and §4.3's Out of Scope calls Administrator editing of Staff-authored interviews "not specified; treat as read-only... unless confirmed otherwise" rather than leaving it ambiguous. `[NOTE FOR PM]` lands on real tensions, not safe checkpoints: the attendance-data-never-surfaced gap (§4.2, "`attendanceStore.listAll()` has no caller"), the FR-14 LMS-dependency blocker (§4.3), and the self-reported-outcome trust gap (§4.3 FR-16 Out of Scope) are all genuine unresolved problems, not rhetorical ones. Open Questions (§8) are actually open — e.g. Q2 ("does an API or export already exist? Who owns granting access?") has no answer baked into the next sentence.

### Findings
- **medium** MVP Scope frames as "minimum viable product" what is actually "current shipped state vs. roadmap" (§6) — §6.1 contains only already-shipped features, and §6.2 defers the PRD's own "primary addition" (§4.3). A reader skimming only §6 could conclude nothing new is being greenlit for build. *Fix:* rename §6 to something like "Current State vs. Roadmap" or add a sentence clarifying that no new capability ships until §4.4/§4.7 land.

## Substance over theater — strong

Two personas (L&D Manager, Employee), both driving specific FRs and JTBDs — no persona padding. No differentiation/innovation section was forced in. NFR-SEC-004 (§4.4, §7) is specific to this product's actual failure mode (single shared credential + no persistence = no real data allowed), not boilerplate "must be secure." The Vision statement (§1) is grounded in the product's actual current state ("Today it ships as a read-only demonstration prototype: one shared admin credential, fictional employee records, no persistence") rather than being swappable into any PRD.

### Findings
- **low** NFR-SEC-004 is referenced by name and consequence in two places (§4.4, §7 SM-C1) but its actual requirement text is never quoted or restated in this PRD — the reader must trust the citation rather than verify it. *Fix:* inline-quote the requirement text (or its operative clause) at first reference in §4.4.

## Strategic coherence — adequate

The thesis is clear and consistent: replace scattered per-person lookups with one workspace, and shift data capture from "L&D manager chases it down" to "employee self-reports it" (§1). Feature ordering in §6.2 follows real dependency logic (gating config → persistence → self-service → editable records → leave), not ease-of-build. SM-1 and SM-2 (§7) measure the thesis directly (adoption vs. the scattered method; time-to-answer for a readiness judgment) rather than raw activity; SM-3 is more activity-shaped ("% of records updated within cadence") but is correctly demoted to secondary, and a counter-metric (SM-C1) is named against SM-1. The one soft spot is noted above under Decision-readiness: the MVP-scope framing doesn't quite match a "minimum viable product" argument, which slightly undercuts the thesis-to-scope link this dimension looks for.

## Done-ness clarity — strong

FR-11 through FR-18 each carry testable consequences, and the PRD is unforgiving with itself about vagueness where it does appear: FR-14's sync fidelity is explicitly marked `[ASSUMPTION: a sync-latency window, not yet defined]` rather than silently asserting "near real-time." Ownership/authorship rules are concrete and repeated correctly across FRs (FR-11 "taken from the signed session, never from the submitted form"; FR-16 "matching the FR-11 pattern"). Field-locking rules are specific (FR-12: "Company, role, and date are locked after creation... Only stage, outcome, and feedback stay editable"; FR-16 mirrors this for project history).

### Findings
- **low** FR-14's degraded-mode consequence — "the employee sees a clear stale/unavailable state rather than blank or stale-looking-fresh data" — specifies the failure mode to avoid but not the bound for what "clear" means (a banner? a timestamp? a blocking state?). *Fix:* either accept as acceptance-criteria-level detail deferred to architecture, or add one sentence naming the minimum signal (e.g., "last-synced timestamp shown, or a synced/unavailable badge").

## Scope honesty — strong

§5 Non-Goals is substantive and specific, not a boilerplate list: it explicitly excludes "Independent verification of Staff-self-reported data" — an omission that could otherwise be silently assumed given §4.3 lets employees self-report interview outcomes and client satisfaction. All three inline `[ASSUMPTION]` tags (§3 BrainStation LMS ownership, §4.3 FR-14 sync-latency, §4.3 FR-18 department-list approach) round-trip cleanly into §9's Assumptions Index. De-scoping is argued, not asserted — §6.2 gives the dependency reasoning for every deferred item. Open-items density (4 Open Questions + 3 Assumptions + 3 `[NOTE FOR PM]`) is proportionate for a PRD that is explicitly not yet green-lit for full build (§6 shows most of its own content deferred) and that supersedes an existing SRS rather than introducing net-new scope from nothing.

## Downstream usability — adequate

Glossary (§3) terms are used consistently across FRs and UJs (Staff/Administrator/External Interview/Training Enrolment/Assignment-Project all track their defined meaning). FR cross-references within this document resolve correctly (UJ-2 → FR-11–FR-13; UJ-3 → FR-14–FR-15; FR-16 → "matching the FR-11 pattern"; FR-17 → "Same visibility rule as FR-13"). The gap is at the boundary with the superseded SRS: this PRD's own FRs start at FR-11 with no FR-1–10 defined anywhere in it, and it cross-references `FR-ORG-002` (§4.3 FR-13) and `FR-DIR-*`/`FR-PROF-*`/`FR-NAV-*` (§4.1) — an entirely different ID scheme from another document — without those IDs being resolvable from this PRD alone. A downstream workflow trying to source-extract FR-13's dependency on `FR-ORG-002` cannot verify it without opening the SRS.

### Findings
- **medium** FR numbering starts at FR-11 with no FR-1–10 present or explained in this document (§4.3). *Fix:* either renumber this PRD's FRs starting at FR-1, or add one sentence stating why FR-11 is the starting point (e.g., "continues SRS's FR numbering scheme") so the gap doesn't read as missing content.
- **low** Cross-references to SRS-scheme IDs (`FR-ORG-002`, `FR-DIR-*`, `FR-PROF-*`, `FR-NAV-*` in §4.1/§4.3) point outside this document and aren't resolvable standalone. Acceptable given the explicit "not re-specified here" design choice in §4.1, but worth a one-line pointer to the SRS file/section for each external ID cited, not just the first.

## Shape fit — strong

The PRD explicitly calibrates its own formality: §2.3 states "Lighter treatment — internal tool, two roles, no complex navigation" before giving three lightweight UJs with role-based protagonists (L&D manager, employee) rather than named personas — correct for a two-role internal capability spec, not under- or over-formalized. §0 correctly identifies this as chain-top (feeds `bmad-architecture` and `bmad-create-epics-and-stories`), which justifies the traceability rigor applied to FR-11–FR-18. Brownfield handling is accurate throughout: shipped vs. roadmap is marked at every feature (§4.1–§4.8), and new UJs (self-service) are clearly distinguished from the one already-shipped JTBD (attendance).

## Mechanical notes

- **Glossary drift**: minimal. British spelling ("Enrolment") is used consistently in §3 and FR-14/FR-15; no case or synonym drift observed across FRs.
- **ID continuity**: FR-11–FR-18 are contiguous and unique within this document. No FR-1–FR-10 exist here (see Downstream usability finding above) — this is a real gap for any tool expecting FR-N to start at 1, even though the PRD's own text explains *why* those features aren't re-specified (just not why numbering starts at 11).
- **Assumptions Index roundtrip**: clean. All three inline `[ASSUMPTION]` tags (§3, §4.3 FR-14, §4.3 FR-18) appear in §9, and §9 has no orphan entries.
- **UJ protagonist naming**: UJ-1/2/3 use role labels ("the L&D manager," "an employee") rather than named individuals — appropriate given the Shape fit verdict (internal, two-role capability spec), not a defect.
- **Required sections**: all present for the agreed stakes (Document Purpose, Vision, Target User, Glossary, Features, Non-Goals, MVP Scope, Success Metrics, Open Questions, Assumptions Index).
- Title itself is marked "*Working title — confirm.*" (line 9) — harmless but still an open item; roll it into §8 Open Questions for tracking consistency if it isn't resolved before this PRD leaves draft.
