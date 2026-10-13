---
title: 'Story 6.2 — Administrator workspace meets contrast'
type: 'chore'
created: '2026-10-08'
status: 'done'
baseline_revision: '51757923f622f25ecc4a77c3377c1f8ff95c4b6b'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-6-1-sign-in-contrast-and-palette.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The directory search box's focus outline (--accent-focus-soft #8891df) is 2.93:1 on white, below the 3:1 non-text minimum.
    evidence: |-
      Existing colour, carried over unchanged (the spec keeps focus rings as they are). The inner input sets outline:none, so this outline is the only focus indicator. No palette pairing covers it.
    location: >-
      src/app/styles.css (.search-box:focus-within)
    severity: low
  - summary: >-
      Form-control borders (--field-border-soft #e4e7ee on white, 1.24:1; --line-strong on the secondary button) fail WCAG 1.4.11 non-text contrast.
    evidence: |-
      Existing colours, tokenised verbatim. This is the non-text contrast gap already recorded in deferred-work.md from Story 6.1.
    location: >-
      src/app/styles.css (.search-box, select, .secondary)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** The Administrator workspace (dashboard, directory and employee profile) still fails WCAG 2.2 AA colour contrast: muted secondary text, footer text and status badges. The axe `color-contrast` rule is switched off for it in `tests/e2e/accessibility.spec.ts` (`scanWithoutContrast`). Its rules also still use about 70 hard-coded colours outside the shared palette.

**Approach:** Extend the Story 6.1 `:root` palette in `src/app/styles.css` so that every colour used by Administrator-workspace rules is a named variable. Passing colours carry over with their values unchanged; only failing ones are adjusted, by the smallest change that passes. Then switch the contrast rule back on for the dashboard, the directory and every profile tab, so CI enforces it.

## Boundaries & Constraints

**Always:**
- Extend the existing `:root` block and naming from Story 6.1 (`--ink`, `--muted`, `--accent-*`, `--surface-*`, `--info-*`, `--danger-*`, ...). Reuse an existing token whenever its value is identical. New tokens are plain hex values (or `color-mix(...)` of tokens for shadows and tints, as `--accent-shadow` does), so `tests/palette-contrast.test.ts` can read them.
- A passing colour keeps its exact value. A failing text colour is darkened (or its background lightened) only until it reaches 4.5:1 (3:1 for large text, 24px, or 18.66px bold), keeping its hue so the look is unchanged.
- After this story, no rule in `src/app/styles.css` except `.staff-*` rules (Story 6.3) and `:root` itself contains a literal colour (`#hex`, `rgb()`/`rgba()`, `hsl()` or a named colour such as `white`). `transparent`, `currentColor` and `inherit` are allowed.
- Every status shown on these screens keeps a visible text label next to its colour (badges, the `.dot` marker, progress and skill ratings keep their text or `aria-label`).
- Keyboard operability, focus rings and `D MMM YYYY` dates are unchanged.

**Never:**
- Edit the staff portal's `.staff-*` rules or `tests/e2e/staff-attendance.spec.ts` (Story 6.3), or change layout, spacing, typography or component markup beyond what contrast requires.
- Weaken a test: no axe rule exclusions, `exclude()` selectors or lowered thresholds.
- Change server, data or database code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dashboard scan | admin signed in, Overview section | axe `wcag2a`/`wcag2aa`/`wcag22aa`, `color-contrast` included: 0 violations | — |
| Directory scan | Employees section, unfiltered, then filtered to no matches (empty state) | 0 violations in both states | — |
| Profile scan | Nadia Rahman's profile, each tab (Overview, Employment, Training, Skills & evaluation, Current work, Interviews, Attendance) | 0 violations on every tab | — |
| Hover/unrendered pairings | text on hover backgrounds, avatar initials, every badge colour | each listed pairing meets its threshold in `tests/palette-contrast.test.ts` | — |
| Literal colour guard | `src/app/styles.css` | no literal colour outside `:root` and `.staff-*` rules | test fails naming the offending rule |

</intent-contract>

## Code Map

- `src/app/styles.css` -- one minified line per block; `:root` (line 1) holds the Story 6.1 palette. About 100 distinct hex values remain. Workspace selectors used by `src/components/portal.tsx` include `.sidebar`, `.workspace*`, `.nav-*`, `.demo-card`, `.admin-identity`, `.topbar`, `.demo-pill`, `.breadcrumb`, `.stat-*`, `.panel*`, `.badge` and its colour variants (`green`, `blue`, `rose`, `amber`), `.dot`, `.avatar` and its colour variants, `.tags`, `.filters`, `.search-box`, `table`/`th`/`td`, `.table-footer`, `.count`, `.empty`, `.tabs`, `.profile-*`, `.details`, `.timeline*`, `.training-row`, `.course-icon`, `.progress-line`, `progress`, `.skill-*`, `.callout`, `.fine-print`, `.big-number`, `.interview-detail`, `.radar-*`, `.focus-*`, `.overlap-avatars`, `.learning-mini`, `.spark` and `.period-label`. Shared rules (`.primary`, `.secondary`, `.text-button`, `.brand`, `.muted`, `small`, `.form-error`) belong to this story too; `.staff-*` rules do not.
- `src/components/portal.tsx` -- read-only, to check which classes render on which screen. The `Badge` component (line 22) maps statuses to colour classes; each keeps its text.
- `src/components/staff-account-panel.tsx` -- renders on the profile Overview tab; its classes must pass too.
- `tests/e2e/accessibility.spec.ts` -- delete `scanWithoutContrast` and its comment. Use `fullScan` for the dashboard and the profile. Add the directory (Employees nav, then a search with no matches for the empty state) and loop over every profile tab (click the tab, wait for `aria-selected="true"`, scan).
- `tests/palette-contrast.test.ts` -- add pairings for colours axe can't see during scans: hover backgrounds with their text, every badge variant (text on its background), avatar initials on each avatar colour, `.nav-item.active`, table header text, the `.demo-pill`, the `.callout`. Each one is named by its tokens.
- `tests/styles-tokens.test.ts` (new) -- parse `src/app/styles.css` into rules (`selector{body}`, including rules nested in `@media`). Fail when a rule other than `:root` whose selector list isn't entirely `.staff-*` has a literal colour, and name the selector in the message.

## Tasks & Acceptance

**Execution:**
- `src/app/styles.css` -- tokenise every workspace colour; adjust only the failing ones -- AC 1, 2.
- `tests/e2e/accessibility.spec.ts` -- contrast on for the dashboard, the directory (including the empty state) and every profile tab -- AC 1.
- `tests/palette-contrast.test.ts` -- pairings for unrendered or hover states, badges and avatars -- AC 1, 3.
- `tests/styles-tokens.test.ts` -- literal colour guard -- AC 2.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- no new entries unless review defers something. The existing Story 6.1 entries for the non-text input-border contrast and the `color-no-hex` guard stay as they are; this story's guard covers non-staff rules, and Story 6.3 extends it to the whole file.

**Acceptance Criteria:**
- Given the dashboard, the directory and an open profile (every tab), when they are scanned with the axe `color-contrast` rule enabled, then there are no failures, including muted secondary text, footer text and status badges.
- Given the colours these screens use, when this story ships, then they come only from named variables in `:root`, and each colour that already passed keeps its previous value.
- Given any status shown on these screens, when it is displayed, then it has a text label as well as its colour.

## Spec Change Log

- 2026-10-08 (review patch, no loopback): the profile account panel renders `.staff-field` inputs, so their three literal colours were tokenised with identical values despite the Code Map's `.staff-*` exclusion; AC2 ("colours these screens use") takes precedence. `src/components/portal.tsx` also gained `role="img"` on `.skill-rating` so the newly scanned Skills tab passes axe's `aria-prohibited-attr`; that was the smallest fix keeping its `aria-label`.

## Review Triage Log

### 2026-10-08 — Review pass
- verdicts: 30 findings — high 0, medium 2, low 13, false 15, maybe-false 0
- findings:
  - `[low]` `[defer]` (blind) Search box focus outline `--accent-focus-soft` is 2.93:1 — an existing colour carried over unchanged, and the spec keeps focus rings; deferred.
  - `[low]` `[reject]` (blind) Progress fill on its track is 2.91:1 — an existing colour; the completion percentage is shown as text beside every bar, so the graphic isn't the only cue. The fix would change a passing token family.
  - `[false]` `[reject]` (blind) ↗ arrow button glyph at rest is 3.39:1 — it is an icon in a button with an `aria-label`, so the 3:1 non-text threshold applies and it passes.
  - `[low]` `[reject]` (blind) Radar-row ↗ glyph is 2.37:1 — an existing decorative glyph in a row whose text names the action; unlikely to matter, and the fix adds aria-hidden markup outside contrast scope.
  - `[low]` `[reject]` (blind) Breadcrumb `/` and empty-state `○` are low contrast — existing decorative separators that carry no information.
  - `[low]` `[reject]` (blind) Symbol-only glyphs need explicit handling — same root cause as the three rows above; decorative, existing.
  - `[medium]` `[defer]` (blind) Form-control borders fail 1.4.11 — existing colours tokenised verbatim; already in deferred-work.md (Story 6.1 non-text contrast item).
  - `[low]` `[reject]` (blind) Many near-duplicate per-component grey tokens — real developer cost, but the intent requires passing colours to keep their exact values, so merging them would change passing colours. Palette consolidation belongs with the epic-wide pass in Story 6.3.
  - `[false]` `[reject]` (blind) Palette test can't read the 8-digit `--surface-translucent` — any pairing naming it makes `hex()` throw, so the failure is loud, not silent. The demo pill is checked against the opaque worst case.
  - `[false]` `[reject]` (blind) e2e misses the Learning, Interviews and Attendance sections and the narrow viewport — the intent names the dashboard, the directory and an open profile; all three are scanned.
  - `[low]` `[reject]` (blind) Literal-colour guard blind spots (var fallbacks, url(#id), strings, color-mix) — none of these forms occurs in the stylesheet (0 `var(--x,` fallbacks), and a more robust parser adds complexity for hypothetical input.
  - `[low]` `[reject]` (blind) Skill-rating `aria-label` lacks the skill name — the label text is existing; the skill name sits in the same row; outside contrast scope.
  - `[low]` `[reject]` (blind) Palette pairings miss some passing combinations (focus ring on panels, stat icons, course icon) — they pass today; extra guards for undemonstrated regressions.
  - `[low]` `[reject]` (edge) var() fallback with a literal escapes the guard — same as the guard blind-spot row; no fallbacks exist.
  - `[low]` `[reject]` (edge) Nested var fallback parsing — same root cause.
  - `[false]` `[reject]` (edge) A statement at-rule (@import/@charset) merges into the next rule — the stylesheet has no statement at-rules (only a BOM before `:root`).
  - `[false]` `[reject]` (edge) Braces inside strings or url() split rules — the stylesheet has no such strings or url() values.
  - `[low]` `[reject]` (edge) Breadcrumb separator — same as the blind row; decorative.
  - `[low]` `[reject]` (edge) Progress fill unpaired — same as the blind row.
  - `[low]` `[reject]` (edge) Search icon and radar glyph — decorative icons next to text labels; existing colours.
  - `[false]` `[reject]` (edge) Only Nadia's profile is scanned — every badge and avatar colour class, the notice and the account panel's classes are covered by palette pairings, so other branches' colours are checked.
  - `[medium]` `[patch]` (edge) `.staff-field` input colours (#dfe3ec, #fff, #6876ec) render in the Administrator profile's account panel but stayed literal under the `.staff-*` exemption, contradicting AC2 — replaced with the identical-value tokens `--field-border`, `--surface`, `--focus-ring` (no visual change).
  - `[false]` `[reject]` (edge) workspace-icon swapped to `--accent-strong` — `--accent` failed there (4.46:1); reusing an existing token is consistent with the spec.
  - `[false]` `[reject]` (intent) AC1 split between axe scans and token pairings — descriptive; the pairings cover only states axe can't render, and the scans run on real DOM.
  - `[false]` `[reject]` (intent) Reading A3 (whole workspace) not scanned — the intent names three screens, and the implementer's throwaway scan of the other sections also showed 0 violations.
  - `[false]` `[reject]` (intent) Guard is whole-file minus `.staff-*`, wider than the screens named — wider enforcement is not a defect.
  - `[false]` `[reject]` (intent) Two failing originals merged into `--text-secondary` — both failed, so "passing colours unchanged" still holds.
  - `[false]` `[reject]` (intent) AC3 has no diff surface — `Badge` already renders every status as text next to its colour, and the scans pass with it.
  - `[false]` `[reject]` (intent) No evidence that e2e ran — `npm run test:e2e` ran: 14/14 passed before and after the patch.
  - `[false]` `[reject]` (verification-gap) No verification gaps — informational.

## Design Notes

**Find the failures first.** Temporarily run the new e2e scans and record each `color-contrast` node (selector, foreground, background, ratio). Then fix those colours and tokenise the rest verbatim. axe reports the exact colours, so there's no guessing.

**The minimal change.** Example: `--muted` already passes on white (Story 6.1). A badge text colour such as `#b7791f` on `#fff7e6` fails, so darken it along the same hue (for example to `#8a5a12`) until it reaches 4.5:1, and record the before and after values in the commit message.

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, unit tests (including the palette and token guard) and the build pass.
- `npm run test:e2e` -- expected: all specs pass with `color-contrast` enabled for the Administrator workspace.

## Auto Run Result

Status: done

**Summary:** The Administrator workspace (dashboard, directory and every profile tab) now passes axe's `color-contrast` rule. The `:root` palette from Story 6.1 grew by 80 tokens, and every rule except `:root` and the `.staff-*` portal rules uses only `var(--…)` colours (the `.staff-field` inputs, which also render on the admin profile, too). Passing colours kept their exact values. About 25 failing text, badge and avatar colours were darkened along their own hue to reach at least 4.6:1. The contrast exclusion (`scanWithoutContrast`) is gone. One markup fix: `role="img"` on the skill rating, so its `aria-label` is valid.

**Files changed:**
- `src/app/styles.css`: palette tokens; failing colours darkened; `.staff-field` input colours tokenised.
- `src/components/portal.tsx`: `role="img"` on `.skill-rating`.
- `tests/e2e/accessibility.spec.ts`: full scans of the dashboard, the directory (including the empty state) and all 7 profile tabs.
- `tests/palette-contrast.test.ts`: 42 new pairings for hover, selected and unrendered states, badges and avatars.
- `tests/styles-tokens.test.ts` (new): literal-colour guard (`.staff-*` exempt until Story 6.3).

**Review:** 30 findings (medium 2, low 13, false 15).
- **Patched:** 1 medium (the `.staff-field` literals on the admin profile).
- **Deferred:** 2 (search focus outline at 2.93:1; form-control borders under 1.4.11, already tracked).
- **Rejected:** 27, with reasons in the triage log (mostly existing decorative glyphs, hypothetical guard inputs, and intent-scope readings).

**Follow-up review recommended:** false. One medium entry was patched, with no high.

**Verification:** `npm run check` passed (22 files, 295 tests, build). `npm run test:e2e` passed 14/14, before and after the patch. It ran with `PLAYWRIGHT_CHANNEL=chromium` and the 1194 builds aliased to 1243 in a scratch `PLAYWRIGHT_BROWSERS_PATH`.

**Residual risks:**
- About 18 close greys with per-component names. Consolidating them is a candidate for Story 6.3's epic-wide pass.
- Decorative glyphs (breadcrumb `/`, ↗, ○) and the progress fill keep their existing low-contrast colours.
