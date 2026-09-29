# AI-DLC tooling

This project uses two AI-agent tool installations. Both are committed so every
teammate gets the same skills without a separate setup step — Claude Code
discovers them automatically once the repo is checked out.

## BMAD-METHOD (`.claude/skills/bmad-*`, `_bmad/`)

An agile-planning-to-build workflow: PRD, architecture, epics/stories, sprint
planning, build, code review, retrospective, and a handful of anytime skills
(help, brainstorming, deep recon, review, party mode). Agents: Mary
(Analyst), John (PM), Sally (UX), Winston (Architect), Amelia (Dev).

- Start with `bmad-help` — it reads project state and recommends what to run
  next.
- Skill definitions live in `.claude/skills/bmad-*/` (Claude Code's required
  discovery path — do not relocate). Config, scripts, and templates live in
  `_bmad/` (the BMAD installer's own convention; `_bmad/config.toml` is
  installer-managed and regenerated on every install — durable overrides go
  in `_bmad/custom/config.toml`, which the installer never touches).
- Generated planning/implementation artifacts (PRDs, architecture docs,
  sprint status) land under `_bmad-output/` at the repo root. That folder is
  gitignored — it's per-run draft output, not the tooling itself.
- To reinstall or update BMAD, re-run its installer; it manages `_bmad/` and
  `.claude/skills/bmad-*/` directly.

## Grill-me / grilling (`.claude/skills/grill-me`, `.claude/skills/grilling`)

A stress-testing skill pair (from `mattpocock/skills`) that grills a plan,
decision, or idea with pointed follow-up questions.

- `skills-lock.json` (repo root) is the installer's lockfile — pins which
  skill versions are installed so everyone gets the same ones.
- `.agents/` is the installer's raw download cache, not the working copy;
  it's gitignored on purpose. `.claude/skills/grill-me` and
  `.claude/skills/grilling` are the synced copies Claude Code actually reads.
- To update, re-run the `mattpocock/skills` installer; it refreshes
  `skills-lock.json` and re-syncs `.claude/skills/`.
