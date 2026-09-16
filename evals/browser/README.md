# BrowserPowers evals (lite)

Deterministic local harness, ported lite from BrowserSkill `evals/browser`.
5 stable `core` cases. Honest `passed vs unverified` — no browser = unverified, never fake-pass.

```bash
node evals/browser/cli.mjs validate
node evals/browser/cli.mjs list
node evals/browser/cli.mjs coverage
# real browser (needs daemon + extension):
BP_BASE=http://127.0.0.1:4199/api node evals/browser/cli.mjs smoke
node evals/browser/cli.mjs smoke --case=form-fill
```

Gates:
- case/fixture change → `validate`
- CLI/daemon/ext change → `validate` + `smoke` (needs browser)
- Never weaken an oracle for green.
