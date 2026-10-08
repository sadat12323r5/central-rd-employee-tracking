---
title: 'Story 6.2 — Administrator workspace meets contrast'
type: 'chore'
created: '2026-10-08'
status: 'ready-for-dev'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-6-1-sign-in-contrast-and-palette.md'
warnings: ['oversized']
deferred: []
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

## Review Triage Log

## Design Notes

**Find the failures first.** Temporarily run the new e2e scans and record each `color-contrast` node (selector, foreground, background, ratio). Then fix those colours and tokenise the rest verbatim. axe reports the exact colours, so there's no guessing.

**The minimal change.** Example: `--muted` already passes on white (Story 6.1). A badge text colour such as `#b7791f` on `#fff7e6` fails, so darken it along the same hue (for example to `#8a5a12`) until it reaches 4.5:1, and record the before and after values in the commit message.

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, unit tests (including the palette and token guard) and the build pass.
- `npm run test:e2e` -- expected: all specs pass with `color-contrast` enabled for the Administrator workspace.
