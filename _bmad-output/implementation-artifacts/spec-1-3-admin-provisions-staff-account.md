---
title: 'Story 1.3 — Administrator provisions a Staff account'
type: 'feature'
created: '2026-10-06'
status: 'blocked'
---

# Story 1.3 — Administrator provisions a Staff account

## Auto Run Result

Status: blocked
Blocking condition: stakeholder decisions not settled by the PRD, the architecture spine, epics.md or the sprint-status action items.

1. **How a new Staff member gets their credentials.** Options:
   - The Administrator sets an initial password and passes it on outside the app. If so, must the staff member change it at first sign-in?
   - Supabase sends an invite or magic-link email. This needs SMTP configured for the shared project; the free-tier default mailer is heavily rate-limited.

   The two give observably different flows and UI, and no planning document chooses between them.
2. **What replaces the public demo's staff access.** The story's AC rejects the shared `DEMO_STAFF_PASSWORD`. That ends the demo's "any demo employee + Staff23Demo!" sign-in and breaks the staff e2e specs. Options:
   - Provision demo Staff accounts with published passwords. This conflicts with "tied to an accountable person".
   - Provision demo Staff accounts with private passwords, so only the team can use the staff portal.
   - Something else.

   This is a System Owner call.

Evidence: searching the PRD, the spine, its memlog, epics.md, epic-1-context.md and docs/ for invite, temporary or initial password, password reset and onboarding found nothing.

Carry-over when unblocked: link `employees.auth_user_id` on create, switch staff reads and the sign-in lookup from the service-role client to the JWT client (from Stories 1.1 and 1.2), and retire `DEMO_STAFF_PASSWORD` and the HMAC staff cookie.
