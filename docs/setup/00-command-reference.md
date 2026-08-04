# Command Reference — What to Run, and Where

**For the manager.** Every command in the project, with the machine and directory it belongs to.

---

## The three places

| Tag | Machine | How to get there |
|---|---|---|
| **[WIN]** | Windows PowerShell | Start menu → Windows Terminal |
| **[WSL]** | Ubuntu inside Windows | Type `wsl` in PowerShell, or use `wsl -d Ubuntu bash <script>` |
| **[LINODE]** | The mail server | `ssh root@172.105.57.198` |

Anything ending `.ps1` runs in **[WIN]**. Anything ending `.sh` runs in **[WSL]** or **[LINODE]** — PowerShell cannot execute shell scripts.

---

## Daily — local development

### Start everything and verify it

**[WIN]** · `C:\Users\amitd\Downloads\tatvaOS\local`

```powershell
wsl -d Ubuntu bash ./scripts/up.sh
```

Builds, waits for the stack to stabilise, runs both test suites, prints one verdict. Runs diagnostics automatically if anything fails. **This is the only command you need most days.**

### Stop everything

**[WIN]** · `...\tatvaOS\local`

```powershell
docker compose down
```

### Wipe and start clean

**[WIN]** · `...\tatvaOS\local`

```powershell
docker compose down -v
docker compose up -d --build
```

`-v` deletes the database. Required after any change to `postgres/init/*.sql` — those files only run on an empty volume.

---

## Testing

### Set up the tester environment

**[WIN]** · `...\tatvaOS\local`

```powershell
docker compose --profile testers up -d
wsl -d Ubuntu bash ./scripts/seed-testers.sh
```

Then testers open **http://localhost:8000**. Guide: `docs/setup/07-tester-guide.md`

### Run the test suites individually

**[WIN]** · `...\tatvaOS\local`

```powershell
wsl -d Ubuntu bash ./scripts/test-mail.sh
wsl -d Ubuntu bash ./scripts/test-isolation.sh
```

### Something is broken — find out what

**[WIN]** · `...\tatvaOS\local`

```powershell
wsl -d Ubuntu bash ./scripts/diagnose.sh
```

Walks the stack bottom-up and stops at the first real break. **Read section 4 first.**

---

## Environment

### Check what is installed and what each tool is for

**[WIN]** · `C:\Users\amitd\Downloads\tatvaOS`

```powershell
.\scripts\inventory.ps1
```

### Diagnose a broken environment

**[WIN]** · `C:\Users\amitd\Downloads\tatvaOS`

```powershell
.\scripts\doctor.ps1
```

### Install or repair tooling

**[WIN] — must be elevated (Run as Administrator)** · `C:\Users\amitd\Downloads\tatvaOS`

```powershell
.\scripts\setup-dev-env.ps1
```

Skips anything already present. `-DryRun` to preview, `-Upgrade` to refresh.

---

## Phase 0 — the mail server

### 1. Check DNS before sending anything

**[WSL]** · `~/code/tatvaOS/infra/scripts` — or **[LINODE]**

```bash
./check-dns.sh tatvaos.com 172.105.57.198
```

Run until fully green. A new IP's first messages are the ones receivers weigh most.

### 2. Copy files to the server

**[WIN]** · `C:\Users\amitd\Downloads\tatvaOS`

```powershell
scp infra\dkim\tv2026a.key root@172.105.57.198:/root/
scp infra\scripts\*.sh     root@172.105.57.198:/root/
```

### 3. Provision the server

**[LINODE]** · `/root`

```bash
mkdir -p /etc/opendkim/keys/tatvaos.com
mv /root/tv2026a.key /etc/opendkim/keys/tatvaos.com/tv2026a.private
chmod +x /root/*.sh
./provision-mail-server.sh
```

Run once. Idempotent — re-running repairs rather than duplicates.

### 4. The Phase 0 gate — after Linode lifts the SMTP block

**[LINODE]** · `/root`

```bash
export SEED_GMAIL=you@gmail.com
export SEED_OUTLOOK=you@outlook.com
export SEED_YAHOO=you@yahoo.com
./deliverability-test.sh
```

Only sends to addresses you set. Writes a results template to `results/` — **filling it in by hand is the deliverable.**

---

## Git

**[WIN]** · `C:\Users\amitd\Downloads\tatvaOS` — always the repo root, never a subfolder

```powershell
git status
git add -A
git commit -m "message"
```

### If you see "index.lock: File exists"

**[WIN]** · `C:\Users\amitd\Downloads\tatvaOS`

```powershell
Remove-Item .git\index.lock
Get-ChildItem .git\objects -Recurse -Filter "tmp_obj_*" | Remove-Item -Force
```

A stale lock from an interrupted git process. Safe to delete when no git command is running.

---

## Quick lookup

| I want to… | Where | Command |
|---|---|---|
| Start and verify everything | [WIN] `local` | `wsl -d Ubuntu bash ./scripts/up.sh` |
| Give testers an environment | [WIN] `local` | `docker compose --profile testers up -d` |
| Find out why mail is broken | [WIN] `local` | `wsl -d Ubuntu bash ./scripts/diagnose.sh` |
| See what is installed | [WIN] root | `.\scripts\inventory.ps1` |
| Fix a broken environment | [WIN] root | `.\scripts\doctor.ps1` |
| Check DNS is correct | [WSL] or [LINODE] | `./check-dns.sh tatvaos.com 172.105.57.198` |
| Set up the mail server | [LINODE] `/root` | `./provision-mail-server.sh` |
| Run the Phase 0 gate | [LINODE] `/root` | `./deliverability-test.sh` |
| Commit work | [WIN] root | `git add -A && git commit -m "..."` |

---

## Web interfaces

| What | URL | When |
|---|---|---|
| Tester webmail | http://localhost:8000 | `--profile testers` running |
| Caught outbound mail | http://localhost:8025 | Always |
| Database browser | http://localhost:8080 | `--profile tools` running |
| Spam filter UI | http://localhost:11334 | `--profile spam` running |

---

## Two rules that prevent most confusion

1. **`.ps1` in PowerShell, `.sh` in WSL or on the Linode.** PowerShell cannot run shell scripts; prefix them with `wsl -d Ubuntu bash`.
2. **Git commands run at the repo root** — `C:\Users\amitd\Downloads\tatvaOS`, never inside `local\` or any other subfolder.
