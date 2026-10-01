# Epic 6 Context: Colour-Contrast Remediation

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make the whole workspace (sign-in page, administrator workspace, and staff portal) meet WCAG 2.2 AA colour contrast. This closes the one known, tracked accessibility gap against the workspace's stated WCAG 2.2 AA target. The work is a palette/token pass over the existing stylesheet. Today the stylesheet has about 106 distinct hard-coded colours, no shared colour variables, and the axe `color-contrast` rule switched off in both accessibility test files. The epic keeps the current look: colours that already pass are tokenised unchanged, so no design sign-off is needed. Each story fixes one area and switches the contrast check back on for it, so CI enforces each fix from the moment it lands.

## Stories

- Story 6.1: Sign-in page meets contrast, and the shared palette exists
- Story 6.2: Administrator workspace meets contrast
- Story 6.3: Staff portal meets contrast

## Requirements & Constraints

- **Target:** WCAG 2.2 AA colour contrast. Every text/background pairing on a remediated screen must pass, with zero axe `color-contrast` failures.
- **Known problem spots:** copy on the lavender panel of the sign-in page; muted secondary text, footer text, and status badges in the administrator workspace (dashboard, directory, open profile).
- **Preserve the look:** colours that already pass become named CSS variables with their values carried over verbatim. Change only failing colours, and only as much as needed to pass.
- **End state:** every colour in `src/app/styles.css` is a named variable, and no hard-coded colour values remain.
- **Status must not rely on colour alone:** every status shown keeps a text label alongside its colour.
- Existing accessibility baselines still apply: controls stay keyboard-operable, and dates stay in `D MMM YYYY` format. Don't regress these while restyling.
- **Done means:** `npm run check` and `npm run test:e2e` pass with the contrast rule enabled for the area the story covers.

## Technical Decisions

- This is CSS/token work only. It has no architectural, data, server, or persistence impact, and the general server-side rules (zod validation, stores, RLS) are irrelevant here.
- All colours live in the single stylesheet `src/app/styles.css`. Introduce CSS custom properties (named variables) there, and touch the same file in all three stories. That overlap is intended.
- Story 6.1 establishes the shared palette (the variable set and naming), and later stories extend it rather than starting a parallel one.
- **Tokenisation scope:** non-failing colours become tokens verbatim, even if that means many variables. This resolves the tension between "keep the look" and "no hard-coded colours remain", and Story 6.3 may be a sizeable tokenisation job as a result.
- **Enforcement through tests:**
  - The sign-in and administrator-workspace scans live in `tests/e2e/accessibility.spec.ts`.
  - The staff-portal scan lives in `tests/e2e/staff-attendance.spec.ts`.
  - Each story removes the `color-contrast` rule exclusion for the area it covers.

## Cross-Story Dependencies

- 6.1 creates the shared palette that 6.2 and 6.3 build on, so do it first.
- 6.3 carries the epic-wide "no hard-coded colour values remain" check, so it should land last.
- The epic has no dependency on any other epic and can be sequenced anywhere.
- Other epics that add UI (for example interviews, training, assignments, leave, editable records) add styles to the same stylesheet. Any colours they introduce should use the named variables so they don't reopen the gap.
