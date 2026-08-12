# Deploy checklist — for the frontend developer

Covers the Core backend work now on `main`: **profile photos** (migration 13) and the
**forgot-password flow** (migration 14). Both are shipped alongside the matching UI screens.

Run top to bottom. Anything under "if it fails" is the recovery, not a normal step.

---

## 0. Before you deploy — protect the working tree

The checkout can carry **uncommitted Mail-lane changes**. A `git reset --hard` on the
server won't touch your laptop, but make sure nothing you need is uncommitted locally first.

```bash
git status --short        # expect this to be clean, or only files you mean to leave
git fetch origin
git log origin/main -1    # confirm the tip is the forgot-password/reset screens commit
```

---

## 1. Push (from Windows, if not already pushed)

```powershell
cd C:\Users\amitd\Downloads\tatvaOS
git push origin main
```

## 2. Deploy (on the server)

```bash
ssh -i C:\Users\amitd\.ssh\tatvaos_deploy deploy@172.105.57.198
cd /srv/tatvaos-production
git reset --hard origin/main
./infra/scripts/deploy.sh production
```

`deploy.sh` re-applies every `local/postgres/init/*.sql` idempotently, so migrations **13**
(`user_avatars`) and **14** (`password_reset`) run automatically. Both use
`ADD COLUMN IF NOT EXISTS` / `IF NOT EXISTS`, so re-running is safe.

---

## 3. Verify the migrations landed

Set the compose shortcut first (once per SSH session):

```bash
C="docker compose -f infra/docker/docker-compose.base.yml -f infra/docker/docker-compose.production.yml --env-file infra/docker/.env"
```

**Password-reset columns:**

```bash
$C exec postgres psql -U tatvaos -d tatvaos -c "\d core.users" | grep password_reset
```
Expect four rows: `password_reset_hash`, `password_reset_sent_at`,
`password_reset_attempts`, `password_reset_channel`.

**Avatar table:**

```bash
$C exec postgres psql -U tatvaos -d tatvaos -c "\dt core.user_avatars"
```
Expect one row for `core.user_avatars`.

**Sign-in alert fingerprint (migration 15):**

```bash
$C exec postgres psql -U tatvaos -d tatvaos -c "\d core.refresh_tokens" | grep device_key
```
Expect one `device_key` column.

---

## 4. Smoke-test in the browser

- **Profile photo:** People → open a person → upload a photo. It shows in the list and in
  the top-right header. As an ordinary (non-admin) user, set your own photo on the account
  page — it should succeed (self-service is allowed).
- **Forgot password (phone):** login screen → "Forgot password?" → phone tab → enter a
  registered number → a code arrives (or shows on screen in testing mode) → set a new
  password → sign in with it. All old sessions are signed out, so any other logged-in tab
  should drop to the sign-in screen.
- **Forgot password (email):** the request always says "if an account exists…". The link
  will only actually deliver in production once the Linode **SMTP-unblock** ticket is
  resolved — local delivery to hosted mailboxes works today.
- **New-device sign-in alert:** sign in from a browser you have not used before (a
  different browser, or a private window on a different OS — note a private window in the
  *same* browser is the same device by design). Expect a "New sign-in to your account"
  email. **Your first sign-in after this deploy will NOT alert** — that suppression is
  deliberate, so nobody gets told their own everyday laptop is unrecognised on release
  day. The one after it, from a genuinely different browser, will.

---

## If it fails

- **API won't start / EF schema error** (`column ... does not exist`): the SQL migration
  didn't apply before the API booted. Re-run `./infra/scripts/deploy.sh production`; check
  `$C logs postgres` for the migration NOTICE lines and `$C logs api` for the EF error.
- **Caddy / routing:** no Caddyfile changes in this deploy, so nothing to reload here.
- **Rollback:** `git reset --hard <previous-good-sha>` then re-run `deploy.sh`. The
  migrations are additive (new columns/table only) — a rollback of code leaves them in
  place harmlessly.
