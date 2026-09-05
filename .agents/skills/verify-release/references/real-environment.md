# Real-environment recipes (read-only)

Recipes for working against the user's live `~/.dsh` without modifying it.
`~/.dsh` is the real environment: any write needs the user's explicit
confirmation, and even then back up the original file beside the changed one.

## Programmatic access to the running `dsh web` (cookie minting)

The web root answers 401 without the per-process boot token, which exists only
inside the booting process. For an already-running server, mint an equivalent
session cookie instead — the signing secret is the persisted credential record
`client-connection/browser-session` in `~/.dsh/.credentials.yaml`:

```sh
node -e '
const { createHash, createHmac } = require("crypto");
const fs = require("fs");
const yaml = fs.readFileSync(process.env.HOME + "/.dsh/.credentials.yaml", "utf8");
const b64uD = v => Buffer.from(v.replaceAll("-","+").replaceAll("_","/"), "base64");
const b64uE = b => Buffer.from(b).toString("base64").replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
const secret = b64uD(yaml.match(/browser-session:[\s\S]*?secret: (\S+)/)[1]);
const authority = "localhost:3080"; // host:port of the running dsh web
const issuedAt = Date.now(), expiresAt = issuedAt + 3600_000;
const body = b64uE(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt })));
const sig = b64uE(createHmac("sha256", secret).update(body).digest());
console.log("dsh-auth-" + b64uE(createHash("sha256").update(authority).digest()) + "=v1." + body + "." + sig);'
```

Send it as a `Cookie:` header (curl) or via `document.cookie` on an
already-authenticated same-origin page. The name/payload/signature mirror the
harness `dsh-client-connection` browser-auth: cookie name
`dsh-auth-<base64url(sha256(authority))>`, value `v1.<payload>.<sig>`,
HMAC-SHA256 over the base64url body. Delete minted cookie files when done.

## Sandbox clone of the real profile

Reproduce real-profile boot failures or rehearse durable-store migrations
without touching `~/.dsh`:

```sh
SANDBOX=/tmp/dsh-sandbox
rm -rf "$SANDBOX" && mkdir -p "$SANDBOX/home/profiles"
cp -R ~/.dsh/profiles/web "$SANDBOX/home/profiles/web"
cp ~/.dsh/settings.yaml "$SANDBOX/home/settings.yaml"      # optional
cp -R ~/.dsh/storages "$SANDBOX/home/storages"             # only for migration rehearsals

# Relative @qihongmu links break under the new root — relink absolutely:
M="$SANDBOX/home/profiles/web/node_modules/@qihongmu"; R=<path-to-plugins-repo>/packages
ln -sfn "$R/<plugin>/host"    "$M/dsh-plugins-<plugin>"
ln -sfn "$R/<plugin>/remotes" "$M/dsh-client-remotes-<plugin>"
ln -sfn "$R/<plugin>/client"  "$M/dsh-client-ui-<plugin>"

# Boot from the source harness (the same code the real web runs):
cd <harness-checkout> && DSH_HOME="$SANDBOX/home" pnpm dsh web --no-open --port 3211
```

- Audit the clone for broken links after copying
  (`find .../node_modules -type l ! -exec test -e {} \; -print`); the
  `.dsh-module-fallback` links are absolute into the real profile and survive
  as-is.
- The boot log prints the token URL; probe it the way `verify-env.sh probe`
  does.
- Migration rehearsal: after boot, verify the new store layout (record count),
  recompute an aggregate total against the pre-copy store, and checksum the
  legacy file in BOTH homes — it must stay byte-identical (migrations read it,
  never rewrite it).
- Clean up: kill the booted process, `rm -rf "$SANDBOX"`.
