# Publish failure triage

npm's error text is known to mislead. Diagnose in this order.

## 1. Read the workflow's own triage output first

`publish.yml` prints, before publishing: `npm --version`, whether
`ACTIONS_ID_TOKEN_REQUEST_URL` / `..._TOKEN` are SET, and the result of a
direct OIDC exchange probe against the registry. Interpret:

- npm < 11.5.1 → trusted publishing unsupported (workflow installs
  `npm@latest` for exactly this reason; if that step is missing/skipped,
  this is the bug).
- `ACTIONS_ID_TOKEN_*` not SET → the runner withheld the id token; check the
  job has `permissions: id-token: write` and the repo is **public** (trusted
  publishing does not work from a private repository).
- Exchange probe returns 404 `package not found` → **misleading**. The
  package exists. npm's exchange endpoint returns that for any
  Trusted-Publisher config that is missing or mismatched. Check on
  npmjs.com → package → Settings → Trusted Publisher: repository
  `qihongmu/dsh-plugins`, workflow filename `.github/workflows/publish.yml`
  (owner spelling matters — it was once `qihong` instead of `qihongmu`,
  which broke the whole chain).

## 2. The publish command only says ENEEDAUTH

npm silently skips trusted publishing when anything above is wrong and the
publish step then fails with `ENEEDAUTH`. Do not "fix" it by adding a token;
fix the TP config / permissions. To make the registry say the real reason,
POST the OIDC id token directly:

```sh
curl -sS -X POST \
  "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@qihongmu%2Fdsh-plugins-scheduled-task" \
  -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json"
# ID_TOKEN: minted from ACTIONS_ID_TOKEN_REQUEST_URL with
# audience=npm:registry.npmjs.org — publish.yml does this for you.
```

## 3. Token-mode quirks (bootstrap phase only)

- A granular access token does **not** bypass 2FA for publish (EOTP) unless
  created with the bypass allowlist — prefer OIDC once TP is configured.
- Scoped `E404` on publish/install: first run `npm whoami`; a stale login
  causes it (`npm logout && npm login` cures it).

## 4. Registry / dist-tag quirks

- New package view lags a few minutes after first publish — the PUT receipt
  is authoritative; retry `npm view` later.
- npm rejects a prerelease version published without an explicit tag
  defaulting to `latest`; prereleases go out `--tag alpha` (the workflow
  derives this from the version string). To promote a later stable:
  `npm dist-tag add @qihongmu/<pkg>@<version> latest`.
- Local verdaccio rehearsal: clear `dist/*.tgz` before re-running the
  publish step or it dies on E409 (already exists).

## 5. Workflow-file guard rails

- Tag `vX.Y.Z` must equal the host manifest version — the guard fails with
  "bump the four manifests first"; fix the manifests, do not retag.
- Publish order host → remotes → client → bundle is load-bearing (bundle
  depends on the halves); do not parallelize.
