# EP-TRAIN-6D-4G — Neon `neondb_owner` credential rotation runbook

> **Audience.** Founder (operator). This runbook is the ONLY set of
> steps that require founder interaction in external consoles.
> Claude cannot perform any of them.

> **Scope.** Rotates ONE credential: the Neon Postgres role
> `neondb_owner` on the **staging** project (database `spectre`).
> Does NOT rotate any production credential, any R2 / AWS / Fly API /
> Microsoft Graph credential, or any session secret.

## 1. Why this rotation is needed

A scratchpad preflight script run during EP-TRAIN-6D-4F used a
hand-rolled regex to "extract the database name" from the direct
Postgres URL. The regex was greedy and the capture group ran from
the first literal slash in `://` through the userinfo, printing the
`neondb_owner` password into the local terminal scrollback.

- Scope of the exposure: **local terminal scrollback on the
  founder's Windows machine**, during a single preflight run.
- No commit, no PR, no telemetry channel, and no external log was
  touched.
- The exposure is still treated as if the credential were leaked —
  we rotate.

The sanitizer that produced the leak has been replaced (Phase 1B of
this slice) with a shared parser in
[src/lib/security/db-url-redact.ts](../../../src/lib/security/db-url-redact.ts),
regression-tested against synthetic credentials in
[tests/security-db-url-redact.test.ts](../../../tests/security-db-url-redact.test.ts).
The scratchpad script itself (`scratchpad/ep-train-6d4f/db-preflight.mjs`)
has also been corrected in-place so a future re-run cannot repeat
the leak.

## 2. What must be rotated

ONE password reaches three Fly secrets and one local `.env.*.local`:

| System | Secret key | App | Notes |
|---|---|---|---|
| Fly | `DATABASE_URL` | `spectre-staging` | pooled Neon endpoint (used by runtime) |
| Fly | `DIRECT_DATABASE_URL` | `spectre-staging` | unpooled Neon endpoint (used by `prisma migrate deploy` in `release_command`) |
| Fly | `DATABASE_URL` | `spectre-staging-worker` | pooled Neon endpoint (same credential) |
| Local | `.env.staging.local` | founder's workstation | gitignored; `.env.staging` is NOT in git |

**Nothing else.** GitHub Actions secrets carry no Neon credential
(`.github/workflows/deploy-staging.yml` references only
`FLY_API_TOKEN` and `FLY_WORKER_API_TOKEN`).

Both `DATABASE_URL` (pooled, host `*-pooler.c-3.us-east-2.aws.neon.tech`)
and `DIRECT_DATABASE_URL` (direct, host `*.c-3.us-east-2.aws.neon.tech`)
use the SAME `neondb_owner` password — rotating the Neon role
rotates both endpoints at once.

## 3. Credential-safety rules

1. **The new password is never typed into Claude Code's terminal.**
   Paste it directly into `flyctl` via a separate PowerShell window.
2. **The new password is never pasted into a document, PR, or
   commit.** Only its digest (visible in `flyctl secrets list`)
   is acceptable evidence of rotation.
3. **The new password is never logged.** `flyctl secrets set`
   does not echo its arguments by default; keep it that way.
4. **If the rotation command typo'd a secret**, do not try to
   `grep history` for the correct value — regenerate from Neon.

## 4. Rotation procedure

### Step 4.1 — Verify current Fly release before touching anything

```powershell
flyctl status --app spectre-staging
flyctl status --app spectre-staging-worker
```

Record the current release number for BOTH apps. This is the
rollback anchor if the rotation fails mid-way.

Expected baseline (EP-TRAIN-6D-4F closeout):
- `spectre-staging`: **Fly v1092** / commit `sha-4948e9ab31f6`
- `spectre-staging-worker`: unchanged by 6D-4F (no worker deploy)

### Step 4.2 — Reset the Neon password

1. Open the Neon console → `spectre` project (NOT production).
2. Branches → `main` → Roles & databases → role `neondb_owner`.
3. Click **Reset password**. Neon generates a new password and
   displays it ONCE.
4. Click **Copy to clipboard**. The clipboard now holds the new
   password only.
5. Open a NEW PowerShell window (NOT the one Claude is attached to).

> **Important timing note.** Neon's "Reset password" is atomic —
> the old password becomes invalid the moment the reset completes.
> The staging apps will lose database connectivity until Step 4.3
> finishes. This is acceptable for staging. If you want to minimise
> the outage window, have the Step 4.3 commands ready to run
> *before* clicking Reset.

### Step 4.3 — Update Fly secrets (NEW PowerShell window)

In the new PowerShell window, set three environment-variable
placeholders so the password never appears on the `flyctl` command
line directly. Replace `<PASTE_NEW_PASSWORD>` with a paste from the
clipboard; redact the terminal afterward:

```powershell
# One-shot: hold the new password in a local variable.
$NewPw = Read-Host -AsSecureString "New neondb_owner password"
$PlainPw = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($NewPw))

# Build both connection strings. Host portions come from the EXISTING
# fingerprint — only the password changes.
$Pooled = "postgresql://neondb_owner:$PlainPw@ep-delicate-band-aj3vxkxu-pooler.c-3.us-east-2.aws.neon.tech/spectre?sslmode=require&channel_binding=require"
$Direct = "postgresql://neondb_owner:$PlainPw@ep-delicate-band-aj3vxkxu.c-3.us-east-2.aws.neon.tech/spectre?sslmode=require&channel_binding=require"

# Push to both apps. --stage to batch the restart; -no-restart if you
# prefer to control restart timing.
flyctl secrets set DATABASE_URL=$Pooled DIRECT_DATABASE_URL=$Direct --app spectre-staging
flyctl secrets set DATABASE_URL=$Pooled --app spectre-staging-worker

# Scrub both variables from the session.
$PlainPw = $null
$NewPw = $null
Remove-Variable Pooled, Direct, PlainPw, NewPw -ErrorAction SilentlyContinue
Clear-History
```

Fly will rolling-restart both apps automatically after each
`secrets set`. Expect ~1–2 minutes per app.

### Step 4.4 — Update local `.env.staging.local` (founder machine only)

Open `.env.staging.local` in a non-Claude editor (Notepad is fine).
Replace the `DATABASE_URL=...` and `DIRECT_DATABASE_URL=...` lines
with the two strings from Step 4.3. Save. **Do NOT commit** — this
file is `.gitignore`'d and must remain so.

### Step 4.5 — Verify application connectivity

```powershell
# Health check — this hits /api/health which executes a trivial
# query against DATABASE_URL.
curl.exe -sS -o NUL -w "HTTP %%{http_code}`n" https://staging.spectreautomation.com/api/health

# Verify Fly secret digests changed (NEW digests confirm rotation).
flyctl secrets list --app spectre-staging        | findstr DATABASE_URL
flyctl secrets list --app spectre-staging-worker | findstr DATABASE_URL
```

Both `DATABASE_URL` and `DIRECT_DATABASE_URL` digests MUST differ
from the pre-rotation values recorded in the acceptance document.
Pre-rotation digests (for comparison, from `flyctl secrets list`
captured 2026-11-04 before rotation):

- `spectre-staging` / `DATABASE_URL`         → `08a637cb96dda74a`
- `spectre-staging` / `DIRECT_DATABASE_URL`  → `f3f261d7c1487337`
- `spectre-staging-worker` / `DATABASE_URL`  → `08a637cb96dda74a`

Any new digest different from these is acceptable evidence of
rotation. Record the new digests in the acceptance document
(PHASE-D-4G-ACCEPTANCE.md, §1).

### Step 4.6 — Verify the old password is dead

Still in the SEPARATE (non-Claude) PowerShell window, try a Prisma
command against the OLD password. The expected result is an auth
failure. Do NOT run this from Claude's terminal — Claude's shell
environment still holds the old value in session state until the
machine's PATH refreshes.

```powershell
# Restore the OLD URL into a shell-local variable (copy from
# .env.staging.local pre-rotation if you captured it; otherwise
# skip this step and trust /api/health).
$OldUrl = "<paste-OLD-DATABASE_URL>"
$env:DATABASE_URL = $OldUrl
npx prisma db pull --print 2>&1 | Select-String -Pattern "Authentication|P1000|P1001|OK"
# Expected: P1000 — Authentication failed
$env:DATABASE_URL = $null
Remove-Variable OldUrl -ErrorAction SilentlyContinue
```

If `/api/health` returns `200` AND the old password is confirmed
dead (OR skipped as too risky to reconstruct), rotation is
complete.

## 5. Rollback

If the rotation leaves the apps unable to connect:

1. In Neon, reset the password AGAIN and produce another new value.
2. Re-run Step 4.3 with the second new password.
3. Re-verify `/api/health`.

Fly keeps the prior release artifact in its registry; if
`release_command` fails on the next deploy because of a bad
`DIRECT_DATABASE_URL`, roll back with:

```powershell
flyctl releases list --app spectre-staging
flyctl deploy --image <previous-image-sha> --app spectre-staging --strategy immediate
```

(Images are retained for 7 days by Fly's registry.)

## 6. Post-rotation closure

Record in `PHASE-D-4G-ACCEPTANCE.md` §1:

- Pre-rotation digests (listed in Step 4.5 above).
- Post-rotation digests (from Step 4.5, after).
- Rotation timestamp.
- Confirmation that `/api/health` returned 200 within 5 minutes of
  the rotation.
- Confirmation that the old password is dead (or explicitly skipped
  verification with reason).

No credential value — pre-rotation or post-rotation — is written to
the acceptance document.

---

**STOP.** The rotation is a founder-only action. After it completes,
notify Claude to resume EP-TRAIN-6D-4G at Phase 3 (DRH-1 deploy for
the CLUB_ADMIN RBAC grant).
