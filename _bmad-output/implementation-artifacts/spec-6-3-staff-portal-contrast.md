---
title: 'Story 6.3 — Staff portal meets contrast'
type: 'chore'
created: '2026-10-08'
status: 'done'
baseline_revision: 'ed8b7a6e1d1709f1002905eb02cb729ea4b710b5'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-6-2-admin-workspace-contrast.md'
warnings: []
deferred:
  - summary: >-
      Form-control borders (--field-border, now also on the staff work-mode labels) fail WCAG 1.4.11 non-text contrast.
    evidence: |-
      Existing colour tokenised verbatim; already tracked in deferred-work.md from Stories 6.1 and 6.2. Epic 6 is text-contrast only, so it needs a scope decision.
    location: >-
      src/app/styles.css (.staff-modes label, .staff-field input)
    severity: medium
  - summary: >-
      docs/SRS.md still describes colour contrast as an open gap now that Epic 6 is complete.
    evidence: |-
      Pre-existing deferred-work.md entry from Story 6.1 (NFR-UX-004, Section 8 table, Section 11.7).
    location: >-
      docs/SRS.md
    severity: low
---

<intent-contract>

## Intent

**Problem:** The Staff portal is the last area whose axe scans run with `color-contrast` disabled (`tests/e2e/staff-attendance.spec.ts`), and its `.staff-*` rules still hold literal colours, so the epic's end state ("no hard-coded colour values remain in `src/app/styles.css`") is not met. One of those literals fails: the `.staff-status` confirmation text `#45866b` is 4.31:1 on white and 4.02:1 on the page background.

**Approach:** Tokenise the remaining `.staff-*` literals into the existing `:root` palette (reusing identical-value tokens), darken only the failing status green along its hue, switch the contrast rule back on for the Staff portal scans, and extend the literal-colour guard to the whole file by removing the `.staff-*` exemption.

## Boundaries & Constraints

**Always:**
- Reuse an existing token whenever its value is identical (`#fff` → `--surface`, `#dfe3ec` → `--field-border`, `#eeeffc` → `--accent-selected`, `#f0f2f5` → `--line-divider`). New tokens are plain hex values in the existing `:root` block, named in its convention.
- Passing colours keep their exact value (`#434fc4` on `#eeeffc` is 5.83:1 and stays `#434fc4` as a new token). The failing status green is darkened along its own hue only until it reaches at least 4.5:1 on both `--surface` and `--background` (about `#407d64`).
- After this story, no rule in `src/app/styles.css` other than `:root` contains a literal colour (`#hex`, colour functions, or named colours). `transparent`, `currentColor` and `inherit` stay allowed.
- Keyboard operability, focus rings, status text labels and `D MMM YYYY` dates are unchanged.

**Never:**
- Change colours that already pass, merge near-duplicate tokens, or change layout, spacing, typography or markup beyond what contrast requires.
- Weaken a test: no axe rule exclusions, `exclude()` selectors or lowered thresholds.
- Change server, data or database code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Portal before clock-in | Staff signed in, "Clock in" visible | axe `wcag2a`/`wcag2aa`/`wcag22aa` with `color-contrast` on: 0 violations | — |
| Portal after saving a log | "Daily log saved." status shown | 0 violations, including the `.staff-status` text | — |
| Unrendered states | selected work-mode label, status text on white and page background | each pairing meets its threshold in `tests/palette-contrast.test.ts` | — |
| Literal colour guard | `src/app/styles.css` | no literal colour outside `:root` | test fails naming the offending rule |

</intent-contract>

## Code Map

- `src/app/styles.css` -- `:root` (line 1) holds the palette from 6.1/6.2. Only five rules still have literals: `.staff-header` (`#fff`), `.staff-status` (`#45866b`, failing), `.staff-modes label` (`#dfe3ec`, `#fff`), `.staff-modes label:has(input:checked)` (`#eeeffc`, `#434fc4`), `.staff-task-row` (`#f0f2f5`). Everything else in the portal (`.panel`, `.muted`, `.callout`, `.primary`, `.secondary`, `.text-button`, `.form-error`, `.staff-field`, `.avatar`) is already tokenised by 6.2.
- `src/components/staff-attendance.tsx` -- read-only. `.staff-status` is the `role="status"` message (line ~26) rendered inside the white `.panel` sections; `.staff-modes` is the work-mode fieldset; `.staff-header` the top bar.
- `tests/e2e/staff-attendance.spec.ts` -- `accessibilityScan` calls `.disableRules(["color-contrast"])`; remove that call and the comment above it saying contrast stays excluded until 6.3. It scans before clock-in and after "Daily log saved.".
- `tests/styles-tokens.test.ts` -- `isExempt` exempts `.staff-*` rules and the header comment says so; reduce the exemption to `:root` only and update the comment and the self-test (the `.staff-x{color:#fff}` case must now be reported as an offender).
- `tests/palette-contrast.test.ts` -- `pairings` array (line ~36); add a "Staff portal (Story 6.3)" group: status text on `--surface` and on `--background`, selected work-mode text on `--accent-selected`.

## Tasks & Acceptance

**Execution:**
- `src/app/styles.css` -- add tokens for the status green (darkened) and the selected work-mode text (`#434fc4`, unchanged); replace all five rules' literals with `var(--…)` -- AC 1, 2.
- `tests/e2e/staff-attendance.spec.ts` -- re-enable `color-contrast` in both scans -- AC 1.
- `tests/styles-tokens.test.ts` -- guard the whole file except `:root` -- AC 2.
- `tests/palette-contrast.test.ts` -- Staff portal pairings -- AC 1.

**Acceptance Criteria:**
- Given the staff portal, when it is scanned with the `color-contrast` rule enabled in `tests/e2e/staff-attendance.spec.ts`, then there are no failures.
- Given `src/app/styles.css` after this story, when it is inspected, then every colour is a named variable (passing colours carried over unchanged), and no hard-coded colour values remain.

## Spec Change Log

## Review Triage Log

### 2026-10-08 — Review pass
- verdicts: 18 findings — high 0, medium 0, low 12, false 6, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) `--text-fine-print` changed app-wide (#6f7582 → #6c727f) without the spec saying so; it also darkens admin fine print, which passed on white — the colour fails where the portal renders it (`.fine-print` on `--background`, 4.32:1), so it is a failing colour under the epic rule, and it was darkened along its hue only to 4.51:1. The shift on admin screens is 3 RGB units. Recorded in Auto Run Result; no code change.
  - `[false]` `[reject]` (blind) Spec change logs empty although the implementation went beyond plan — the Spec Change Log is reserved for review loopbacks; the deviation is recorded in Auto Run Result.
  - `[low]` `[patch]` (blind) Test comment and matrix call the selected work-mode label unrendered, but it is `defaultChecked` and renders at load — comment corrected (the spec's matrix row is not edited: fixes to this build's spec are rejected).
  - `[low]` `[patch]` (blind) Clocked-out state (`.staff-done`, history badges) never scanned with contrast on — added a third axe scan after clock-out.
  - `[low]` `[reject]` (blind) `--success-status` near-duplicates `--success-ink` — reusing the darker `--success-ink` would darken past the minimum the epic allows; a separate token is the spec-compliant minimal change.
  - `[low]` `[reject]` (blind) deferred-work.md entry for the colour guard left open — deferred-work.md is an append-only log; the PR records that this story satisfies it.
  - `[low]` `[defer]` (blind) Non-text contrast of `--field-border` on form controls (now also `.staff-modes label`) neither fixed nor re-deferred — pre-existing colour, already tracked in deferred-work.md from 6.1/6.2; re-deferred here.
  - `[false]` `[reject]` (blind) sprint-status still says in-progress — the delivery loop sets it to review when shipping.
  - `[low]` `[patch]` (blind) Guard self-test no longer proves `:root` is exempt — added a `:root{--x:#fff}` rule to the self-test input.
  - `[low]` `[patch]` (blind) Status-message comment also explains the fine-print pairing — split as part of the comment fix above.
  - `[false]` `[reject]` (blind) Spec line references out of date — fix would edit this build's spec.
  - `[low]` `[defer]` (blind) `docs/SRS.md` still describes contrast as an open gap — pre-existing, tracked in deferred-work.md from 6.1; now fully stale with the epic complete.
  - `[low]` `[reject]` (edge) Shared `--text-fine-print` change contradicts "never change passing colours" — same root cause as the first row.
  - `[low]` `[reject]` (verification-gap, other) Undocumented `--text-fine-print` change reaches the admin workspace — same root cause as the first row.
  - `[false]` `[reject]` (intent) No evidence the e2e suite ran — `npm run test:e2e` ran 14/14 green on this branch.
  - `[false]` `[reject]` (intent) Unscanned staff states under the broad reading — the clocked-out view is now scanned; error states use `--danger-*` tokens covered by palette pairings, and badges by 6.2 pairings.
  - `[false]` `[reject]` (intent) Comment slip on the selected label — duplicate of the patched row.
  - `[low]` `[reject]` (intent) Fine print reaching the admin surface — same root cause as the first row; see Auto Run Result.

## Design Notes

Story 6.2 recorded "about 18 close greys with per-component names" as a candidate for consolidation in 6.3. Merging them would change passing colours, which the epic forbids, so it stays out of scope. The deferred-work entry from 6.1 asking for a `color-no-hex`-style guard in 6.3's acceptance is satisfied by extending `tests/styles-tokens.test.ts` to the whole file.

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, unit tests (palette pairings and whole-file token guard) and build pass.
- `npm run test:e2e` -- expected: all specs pass with `color-contrast` enabled in the Staff portal scans.

## Auto Run Result

Status: done

**Summary:** The Staff portal now passes axe's `color-contrast` rule, before clock-in, after saving a log, and (new) after clock-out. No literal colour is left anywhere in `src/app/styles.css` outside `:root`, so Epic 6's end state is met. The five remaining `.staff-*` rules now use existing tokens of identical value, plus two new tokens:
- `--accent-selected-text:#434fc4`: value unchanged.
- `--success-status:#407d64`: the failing status green `#45866b` darkened along its hue. It was 4.31:1 on white and is now 4.84:1, and 4.52:1 on the page background.

**Deviation from the Code Map:** with contrast on, the portal's `.fine-print` (shared token `--text-fine-print`) failed on the page background: 4.32:1. It was darkened along its hue from `#6f7582` to `#6c727f`, giving 4.51:1. The token is shared with the Administrator workspace, where it already passed on white (4.62:1, now 4.83:1). This is a 3-RGB-unit shift there. It was treated as a failing colour, because it fails where the portal renders it.

**Files changed:**
- `src/app/styles.css`: two new tokens; `.staff-*` literals tokenised; `--text-fine-print` darkened.
- `tests/e2e/staff-attendance.spec.ts`: contrast rule re-enabled; third scan after clock-out.
- `tests/palette-contrast.test.ts`: four Staff-portal pairings.
- `tests/styles-tokens.test.ts`: the guard covers the whole file (only `:root` exempt); the self-test proves both the `:root` exemption and the `.staff-*` rules.

**Review:** 18 findings (low 12, false 6).
- **Patched:** 4 low. Test comment accuracy, the clocked-out scan, the `:root` self-test case, and the comment split.
- **Deferred:** 2, both pre-existing: non-text contrast of form-control borders, and the stale SRS contrast text.
- **Rejected:** the rest, with reasons in the triage log. Mainly:
  - the fine-print token change, which is justified above;
  - `--success-ink` reuse, which would darken past the minimum;
  - spec and log edits.

**Follow-up review recommended:** false. No high or medium findings were patched.

**Verification:**
- `npm run check` passed: 22 files, 299 tests, build.
- `npm run test:e2e` passed 14/14, before and after the patches. It ran with `PLAYWRIGHT_CHANNEL=chromium` and the installed chromium-1194 aliased to the paths Playwright 1.63 expects.

**Residual risks:**
- Close per-component greys stay unconsolidated, because merging them would change passing colours.
- Decorative glyphs and non-text contrast from 6.1 and 6.2 remain deferred.
