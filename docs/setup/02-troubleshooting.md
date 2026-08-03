# Troubleshooting Setup

Run the doctor first — it checks each layer in the order things actually break:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

---

## `FullyQualifiedErrorId : UnauthorizedAccess`

PowerShell's execution policy is blocking `.ps1` files. Windows ships with this on by default, so it hits everyone once.

**Run once without changing any system setting:**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-dev-env.ps1
```

**Or allow local scripts permanently for your user:**

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
Unblock-File .\scripts\*.ps1
```

`RemoteSigned` permits scripts you wrote locally and requires a signature only for downloaded ones — a reasonable default. `Unblock-File` clears the mark-of-the-web flag that Windows adds to files that arrived from elsewhere.

If it still fails, the error is genuinely about permissions: open PowerShell with **Run as Administrator**.

---

## `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`

The Docker CLI is installed but the daemon is not running. Almost always one of three things:

**1. Docker Desktop is not started.** It does not auto-start after installation.

```powershell
Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
```

Wait for the whale icon in the system tray to stop animating — 30–60 seconds on first launch.

**2. Docker Desktop is not installed** (likely if the setup script never ran):

```powershell
winget install --id Docker.DockerDesktop --exact
```

**3. The WSL2 backend is off.** Settings → General → **Use the WSL 2 based engine** must be ticked.

Then enable integration, or nothing in `local/` will work from inside WSL:

**Settings → Resources → WSL Integration → enable `Ubuntu-24.04` → Apply & Restart**

Verify:

```powershell
docker info                    # from PowerShell
wsl -- docker info             # from WSL - both must work
```

---

## `./scripts/test-mail.sh` does nothing, or "not recognised"

Those are Linux shell scripts. PowerShell cannot execute them.

```powershell
# from PowerShell
wsl bash ./scripts/test-mail.sh
wsl bash ./scripts/test-isolation.sh
```

```bash
# or work inside WSL, which is better anyway
wsl
cd /mnt/c/Users/amitd/Downloads/tatvaOS/local
./scripts/test-mail.sh
```

---

## `sudo: Authentication failed` during Ubuntu provisioning

You have forgotten your Linux password. This is never a problem on WSL — Windows can log into the distro as root without any password.

```powershell
wsl -d Ubuntu -u root -- passwd <your-linux-username>
```

You will be asked for a new password twice, then you can re-run the setup script.

Not sure of the username:

```powershell
wsl -d Ubuntu -- whoami
```

**Linux password prompts display nothing as you type** — no dots, no asterisks, no cursor movement. It looks broken and it is not. Type the password and press Enter.

---

## Correct order when nothing works

Each step depends on the one before it. Skipping ahead is what produces confusing errors.

```powershell
# 1. Unblock scripts
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
Unblock-File .\scripts\*.ps1

# 2. Install everything (ELEVATED PowerShell)
.\scripts\setup-dev-env.ps1

# 3. REBOOT if WSL was just installed

# 4. Launch Ubuntu once from the Start menu, create your Linux user

# 5. Re-run setup - it skips what is already there and provisions Ubuntu
.\scripts\setup-dev-env.ps1

# 6. Start Docker Desktop, enable WSL Integration for Ubuntu-24.04

# 7. Confirm
.\scripts\doctor.ps1

# 8. Bring up the mail stack
cd local
docker compose up -d --build
wsl bash ./scripts/test-mail.sh
```

---

## Other things that come up

| Symptom | Cause and fix |
|---|---|
| `winget` not recognised | Install "App Installer" from the Microsoft Store |
| WSL install fails | Virtualisation disabled — enable VT-x/AMD-V in BIOS |
| `wsl --install` needs a reboot repeatedly | Windows features half-enabled. Reboot fully before retrying |
| Ubuntu opens then closes instantly | Launch it once from the Start menu, not from a terminal, to complete first-run setup |
| Docker very slow, machine crawling | WSL2 eating RAM. Check `%USERPROFILE%\.wslconfig` caps memory to about half your total |
| `port is already allocated` | Something on Windows holds the port. Change the host side of the mapping in `local/docker-compose.yml` |
| Schema edits do nothing | `postgres/init/*.sql` runs only on an empty volume. `docker compose down -v` then up |
| Everything slow after moving the repo | Repo on `/mnt/c`. Move it inside WSL — see the doctor's note |
