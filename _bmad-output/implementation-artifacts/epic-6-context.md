# Epic 6 Context: Colour-Contrast Remediation

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make every part of the workspace meet WCAG 2.2 AA colour contrast, closing the one known accessibility gap. Today the global stylesheet holds about 106 distinct hard-coded colours with no shared colour variables, and both accessibility test files switch the axe `color-contrast` rule off. The epic adds a named-variable palette and fixes only the colours that fail, so the current look stays the same. It works one area at a time (sign-in, Administrator workspace, Staff portal) and turns the contrast check back on for each area as it is fixed, so CI enforces each fix from the moment it lands.

## Stories

- Story 6.1: Sign-in page meets contrast, and the shared palette exists
- Story 6.2: Administrator workspace meets contrast
- Story 6.3: Staff portal meets contrast

## Requirements & Constraints

- **Target:** WCAG 2.2 AA colour contrast for every text/background pairing, including copy on tinted panels (e.g. the lavender sign-in panel), muted secondary text, footer text and status badges.
- **Keep the current look:** colours that already pass become named CSS variables with their values unchanged. Only failing colours change, and only as much as needed to pass. Because of this, no design sign-off is required.
- **End state:** once the epic is done, `src/app/styles.css` has no hard-coded colour values left. Every colour is a named variable, including passing colours carried over verbatim. This makes the last story partly a mechanical tokenisation job, which is intended.
- **Status is never colour alone:** every status indicator has a text label as well as its colour.
- **Other accessibility rules still apply:** controls work with the keyboard alone, and dates render as `D MMM YYYY`. Remediation must not break either.
- **CI enforcement:** each story re-enables the axe `color-contrast` rule for the scans of its area. The sign-in scan is in `tests/e2e/accessibility.spec.ts`; the Staff portal scan is in `tests/e2e/staff-attendance.spec.ts`. The rule must stay on after it is enabled.
- **Done means:** `npm run check` and `npm run test:e2e` pass. The shared Definition of Done items about server actions, RLS and stores do not apply here, because this epic adds no server code or tables.

## Technical Decisions

- This is CSS/token work only. It does not depend on any architecture decision and adds no stores, server actions, data model changes or new dependencies.
- The shared palette is defined as CSS custom properties in the global stylesheet (`src/app/styles.css`). Story 6.1 creates it, and later stories extend it rather than starting a second palette.
- Contrast is verified with the existing Playwright + axe accessibility scans (Playwright 1.63.0), not with a separate tool.

## Cross-Story Dependencies

- Story 6.1 sets up the palette and its naming convention. Stories 6.2 and 6.3 reuse and extend it.
- All three stories edit `src/app/styles.css` (expected), so run them in order to avoid conflicts.
- Story 6.3 completes the "no hard-coded colours" end state, so it should go last.
- This epic does not depend on any other epic and can be scheduled at any point. If other epics add UI before or alongside it, their new colours should use the palette variables.
