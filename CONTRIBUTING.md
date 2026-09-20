# Contributing

## Branch workflow

Keep `main` releasable. Use short-lived branches such as `feat/leave-domain` or `docs/srs-baseline`, open a pull request, and squash after checks and review.

Before editing, pull the latest `main`. Do not have local Codex and ChatGPT Work modify the same branch at the same time; coordinate through separate branches and pull requests.

## Completion gate

Before requesting review:

```bash
npm run check
```

Include tests for changed rules, avoid real employee data, and confirm no `.env` or credentials are staged.

## Commit style

Use concise imperative subjects, for example:

- `Add leave category boundary tests`
- `Enforce employee leave overlap constraint`
- `Document webhook retry behaviour`
