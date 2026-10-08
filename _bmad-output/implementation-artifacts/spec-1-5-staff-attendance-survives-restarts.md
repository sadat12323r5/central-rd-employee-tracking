---
status: blocked
---

# Story 1.5 — Staff attendance survives restarts

## Auto Run Result

Status: blocked
Blocking condition: the story needs a new Supabase `attendance` table, with RLS, applied to the shared project, so the `AttendanceStore` can move from in-memory storage to Supabase and its live and e2e tests can run. The unattended build container cannot reach Supabase Postgres (TCP 5432 to the pooler times out; only HTTPS egress is allowed), so `npm run db:push` cannot apply the migration and `npm run check` / `npm run test:e2e` cannot pass. This is the same blocker as Story 1.4 (draft PR #13). Not attempted in the 2026-10-08 run.

To unblock: give the routine's environment Postgres access, or have a human apply story migrations before each run. Then re-run the routine.
