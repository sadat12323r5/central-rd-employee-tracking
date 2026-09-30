# Review — Version Verification Lens

**Reviewed document:** `ARCHITECTURE-SPINE.md` (L&D Manager Workspace)
**Lens:** Verify every committed technology decision was web-researched or reality-checked, not asserted from training data — current versions, continued existence/fit of each named technology, and (n/a here — brownfield, no starter) live starter defaults. Flag anything stale or unconfirmed.
**Review date:** 2026-09-30
**Cross-checked against:** `package.json` and `package-lock.json` in the project root (ground truth for "installed"), plus independent web searches per package.

## Overall Verdict

**Partial pass, with real gaps.** Two rows (`@supabase/supabase-js`, `@supabase/ssr`) show genuine, dated verification and are accurate. The Next.js row shows real reasoning (compares to 16.3.x, correctly characterizes 15.x's LTS status) but its own cited patch number is stale. The remaining four rows (TypeScript, React, zod, Vitest) are not just unverified — three of them are factually wrong against the project's own lockfile, and two (TypeScript, Vitest) omit a major-version succession that a web check would have surfaced immediately. Playwright is accurate but its currency isn't demonstrated as checked.

## Findings by Severity

### High

**H1 — Vitest is two majors behind current, and the spine doesn't mention it.**
Spine claims `3.2.0`. Lockfile shows `3.2.7` actually installed. Independent web search: **Vitest 5.0 shipped 2026-09-03** (Vitest 4.0 shipped earlier in 2026, with Vitest 5 requiring Node ≥22.12 and Vite ≥6.4, and meaningfully different default behaviors — mocks now auto-cleared, unawaited async assertions now fail, etc.). The current latest is 5.0.2. Nothing in the Stack row acknowledges Vitest 3.x has been superseded twice over, unlike the Next.js row which explicitly reasons about the 15→16 jump. This is exactly the "superseded by a new major version nobody mentioned" failure mode the lens asks to catch — and it has real consequences: any future upgrade will cross two breaking majors at once.

**H2 — TypeScript 7 (native Go compiler) is GA and unmentioned.**
Spine claims `5.9.0`. Lockfile shows `5.9.3` installed. Independent web search: **TypeScript 7.0 reached general availability 2026-07-08** — a full rewrite of the compiler/language service in Go, 8–12x faster builds, now GA on npm (`npm install typescript` pulls a 7.x-capable range unless pinned). There is a legitimate reason a brownfield project might stay on 5.9.x for now (TS7 still lacks a stable programmatic API as of GA, so tools embedding TypeScript — some Astro/Vue/MDX/Svelte/Angular workflows — may still require TS6/5.x), but the spine gives **zero indication this was considered**. No "web-verified" tag, no reasoning, unlike the Next.js entry. This reads as asserted from training data, not checked.

**H3 — Installed Next.js patch is behind a named critical security release.**
Spine says `15.5.0 (installed)`. Lockfile shows the actually-resolved version is `15.5.25`, not 15.5.0 — already a mismatch (see M1). More importantly, web search shows Next.js shipped an **out-of-band security release on 2026-09-22** patching a critical upstream vulnerability, landing at `15.5.26` (and `16.3.6`), with a further scheduled release for `2026-09-30` (today) addressing nine vulnerabilities including one critical, landing at `15.5.27`/`16.3.8`. The project's actually-installed `15.5.25` predates the 2026-09-22 critical-vuln patch. This isn't an architecture-fit question, it's a live, actionable security gap the spine's version claim obscures by understating the installed patch.

### Medium

**M1 — Three "installed" version claims don't match `package-lock.json`.**
The lens explicitly asks to reality-check against the existing project. Ground truth from `package-lock.json`:

| Package | Spine claims | package.json range | Actually installed (lockfile) |
| --- | --- | --- | --- |
| next | 15.5.0 (installed) | ^15.5.0 | **15.5.25** |
| react / react-dom | 19.1.0 | ^19.1.0 | **19.3.0** |
| typescript | 5.9.0 | ^5.9.0 | **5.9.3** |
| zod | 4.1.0 (installed) | ^4.1.0 | **4.6.5** |
| vitest | 3.2.0 | ^3.2.0 | **3.2.7** |
| @supabase/supabase-js | 2.117.2 | ^2.117.2 | 2.117.2 (match) |
| @supabase/ssr | 0.12.7 | ^0.12.7 | 0.12.7 (match) |
| @playwright/test | 1.63.0 | ^1.63.0 | 1.63.0 (match) |

The Stack table appears to have been filled from `package.json`'s declared minimums (or from memory of them) rather than the resolved lockfile — most visibly wrong for **React**: the spine cites 19.1.0 while the project actually has 19.3.0 installed, which happens to *be* current-latest (per web search, React 19.3.0 released 2026-09-09). So the spine understates its own currency here, while overstating it elsewhere (zod, Vitest, Next.js patch). Either way, three of eight rows fail a basic reality-check the lens calls for by name.

**M2 — zod's specific number is stale by five minor versions, despite the row's own "unused" caveat inviting scrutiny.**
Spine claims `4.1.0`. Web search: current latest is `4.6.5` (published ~2026-09-14), matching what's actually in the lockfile. Zod 4 itself is confirmed stable/current (not deprecated, no v5 in sight), so the *technology* choice is fine — but the *specific version number* in the table is simply wrong against both npm-latest and the project's own lockfile, with no annotation suggesting it was checked.

**M3 — No explicit web-verification trail for TypeScript, React, zod, Vitest, or Playwright.**
Only `@supabase/supabase-js` and `@supabase/ssr` carry a dated verification note ("bumped 2026-09-30 ... typecheck/build verified clean"), and even that note documents a *build* check, not a check that the version is current/non-deprecated upstream — it's evidence the package installs and compiles, not evidence of a web/registry check. The Next.js row is the only one with visible reasoning about currency ("current is 16.3.x, 15.x is Maintenance LTS not deprecated"), and that claim independently checks out (Next.js 15.x is documented as Maintenance LTS through 2026-10-21, two years after the 16.0 release). The other five rows carry no such trail at all — consistent with being asserted rather than checked.

### Low

**L1 — Playwright's number is correct but undocumented as checked.**
Spine claims `1.63.0`; web search and lockfile both confirm 1.63.0 is current-latest as of today. No issue with the number, just — like M3 — no visible verification trail.

## What Checked Out Cleanly (for contrast)

- **@supabase/supabase-js 2.117.2** — confirmed current-latest via web search (published ~17 hours before this review), matches package.json and lockfile exactly. This is the one row that reads as genuinely, freshly verified.
- **@supabase/ssr 0.12.7** — confirmed current-latest via web search (published ~9 days prior), matches package.json and lockfile exactly.
- **Next.js's LTS characterization** — "15.x is Maintenance LTS not deprecated" is accurate per Next.js's own support policy (2-year Maintenance LTS window per major, 15.x's runs to 2026-10-21) and is the one piece of qualitative reasoning in the table that shows real research rather than a bare number.
- **All eight named technologies still exist, are still maintained, and are not dead-ended** — no case of a library being deprecated/abandoned outright. The failures here are stale/wrong *version numbers* and *unmentioned major successors*, not wrong technology choices.

## Recommendations

1. Regenerate the Stack table's version column directly from `package-lock.json`, not from memory or `package.json` ranges, and re-annotate each row with the date it was checked.
2. Add a line to the TypeScript and Vitest rows acknowledging the TS7 / Vitest 5 majors exist and stating explicitly why the spine is staying on the current majors (e.g., TS7's missing stable programmatic API; Vitest 4/5's breaking changes not yet evaluated) — mirroring how the Next.js row already handles the 15→16 question.
3. Flag the Next.js patch gap to whoever owns dependency hygiene outside this spine review: installed `15.5.25` predates the 2026-09-22 critical security patch (`15.5.26`) and today's scheduled `15.5.27`.
