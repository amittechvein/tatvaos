# TatvaOS Mail — Development Environment Setup

**Platform:** Windows 11
**Companion to:** Architecture · Technology Stack · Delivery Plan
**Date:** 2 August 2026

---

## 0. The One Thing That Shapes This Setup

**Postfix, Dovecot and Rspamd do not run on Windows.** Neither does most of the mail tooling you will live in. This is not a limitation to work around — it is the defining fact of your setup.

The answer is **WSL2 with Ubuntu**, and it is a genuinely good answer. You get a real Linux kernel, Docker running natively against it, and identical behaviour to your production VMs. Do not attempt to run the mail edge on Windows directly, and do not use a full VM if WSL2 will do — the file-system and memory overhead is not worth it.

**Practical rule that saves a great deal of pain later:** keep all project code **inside the WSL2 filesystem** (`~/code/tatvaos-mail`), not on the Windows drive (`/mnt/c/...`). Cross-filesystem I/O in WSL2 is roughly 10× slower, and with a pnpm monorepo plus .NET builds you will feel it every single day. VS Code's WSL remote extension makes this completely transparent.

---

## 1. Install Everything in One Pass

Two scripts do the whole job:

| Script | Runs on | Does |
|---|---|---|
| **`setup-dev-env.ps1`** | Windows, elevated PowerShell | All winget packages, WSL2 + Ubuntu, `.wslconfig`, VS Code extensions, pnpm — then calls the second script |
| **`setup-wsl.sh`** | Inside Ubuntu | apt tooling, `swaks`, `dig`, `psql`, Node 22 via fnm, pnpm, .NET 10 SDK, shell config, project directory |

```powershell
# from an elevated PowerShell prompt, both scripts in the same folder
.\setup-dev-env.ps1 -DryRun     # see what it will do
.\setup-dev-env.ps1             # do it
```

Budget **45–60 minutes and ~50 GB of disk**. A reboot is required partway through when WSL2 first installs — re-run the script afterwards and it picks up where it left off.

Both scripts are **idempotent**. Re-running skips anything already present, which makes them a repair-and-verify tool as much as an installer. `-Upgrade` refreshes everything instead of skipping.

### Useful flags

| Flag | Effect |
|---|---|
| `-DryRun` | Reports every action, changes nothing |
| `-Upgrade` | Upgrades installed packages rather than skipping them |
| `-Skip Mobile` | Drops Android Studio — saves ~12 GB if you want it later |
| `-SkipWsl` | Skips WSL entirely. Leaves the environment unable to run the mail stack |

### The staleness tradeoff, stated once

Installing everything now means Android Studio sits unused until roughly month 7 and will be several versions behind by then. That is a real cost, but a small one — `winget upgrade --all` (or `.\setup-dev-env.ps1 -Upgrade`) fixes it in one command, and it buys you an environment that never interrupts a sprint. Run the upgrade at the start of each phase and the tradeoff disappears.

One genuine conflict to be aware of: **Docker Desktop and the Android emulator both want the hypervisor.** On current Windows 11 with WHPX they coexist fine, but if the emulator refuses to start once Docker is running, that is the cause — and using a physical Android phone over USB sidesteps it entirely while being closer to reality for push testing anyway.

### What runs when

Even with everything installed, the tools come into use on this schedule:

| Tool | First genuinely needed |
|---|---|
| Git, WSL2, Docker, .NET, Node, VS Code | Day 1 |
| Thunderbird, swaks, dig, Tailscale | Sprint 0.1–0.2 |
| DBeaver, Bruno, cloudflared | Phase 1 (month 2) |
| Android Studio, EAS CLI | Phase 2 (month 7) |
| Terraform, Bitwarden, WinSCP | Phase 3–4 (month 10+) |

---

## 2. Phase A — Core Toolchain (Day 1)

| Tool | Why | winget ID |
|---|---|---|
| **Git** | | `Git.Git` |
| **Windows Terminal** | Tabbed, sane, handles WSL properly | `Microsoft.WindowsTerminal` |
| **PowerShell 7** | The built-in PowerShell 5.1 is old; scripts assume 7 | `Microsoft.PowerShell` |
| **WSL2 + Ubuntu 24.04** | **The critical one.** All mail infrastructure lives here | `wsl --install -d Ubuntu-24.04` |
| **Docker Desktop** | Postgres, Redis, Postfix, Dovecot, Rspamd — all containerised. Enable the WSL2 backend | `Docker.DockerDesktop` |
| **.NET 10 SDK** | LTS, supported to Nov 2028. Not .NET 9 — it goes EOL 10 Nov 2026 | `Microsoft.DotNet.SDK.10` |
| **Node.js 22 LTS** | For Next.js and Expo | `OpenJS.NodeJS.LTS` |
| **pnpm** | Monorepo package manager. Install via `corepack enable`, not npm | — |
| **VS Code** | With the WSL, C# Dev Kit, and Tailwind extensions | `Microsoft.VisualStudioCode` |
| **7zip** | You will need it | `7zip.7zip` |

### Editor choice

VS Code is sufficient for all three surfaces and keeps you in one tool. If you find yourself doing heavy C# refactoring and missing proper tooling, **JetBrains Rider** (`JetBrains.Rider`) is materially better for .NET — but start with VS Code and only add Rider if you feel the gap. Visual Studio 2026 Community is the third option; it is heavy and its WSL story is weaker.

### Post-install, inside WSL

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential curl wget git unzip \
                    dnsutils net-tools swaks postgresql-client

# Node via fnm (per-project versions matter across the monorepo)
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 22 && fnm default 22
corepack enable && corepack prepare pnpm@latest --activate

# .NET SDK inside WSL too — you will build and run there
wget https://dot.net/v1/dotnet-install.sh -O ~/dotnet-install.sh
chmod +x ~/dotnet-install.sh && ~/dotnet-install.sh --channel 10.0
```

> `swaks` is the Swiss Army knife of SMTP testing. You will use it constantly from Phase 0 onward to send crafted messages, test authentication, and reproduce delivery failures.

---

## 3. Phase B — Mail Edge Tooling (Phase 0, week 1)

| Tool | Why | Where |
|---|---|---|
| **Thunderbird** | Real IMAP/SMTP client for testing. The first proof your server works | `Mozilla.Thunderbird` |
| **swaks** | Scripted SMTP testing | WSL (apt) |
| **dig / nslookup** | DNS verification — you will run these hundreds of times | WSL (`dnsutils`) |
| **Mailpit** | Local SMTP catcher for app-level dev, so you are not sending real mail during development | Docker |
| **OpenSSH client** | Built into Windows 11 already | — |
| **Tailscale** | Private access to your VMs without exposing SSH to the internet. Meaningfully reduces your attack surface | `tailscale.tailscale` |
| **cloudflared** | Tunnel for receiving webhooks (relay bounce/complaint callbacks) on localhost | `Cloudflare.cloudflared` |

### Web tools, no install needed

- **mail-tester.com** — your Sprint 0.2 target is 10/10
- **MXToolbox** — blocklist and DNS diagnostics
- **Google Postmaster Tools** and **Microsoft SNDS** — register in Sprint 0.2, before you need the history
- **dmarcian** or **Postmark's DMARC tool** — free DMARC report parsing

---

## 4. Phase C — Backend and Web (Phase 1)

| Tool | Why | winget ID |
|---|---|---|
| **DBeaver** | Free, handles Postgres well, works with WSL-hosted containers | `dbeaver.dbeaver` |
| **Bruno** | API client. Open source, stores collections **as files in your repo** — version-controlled alongside the API, unlike Postman's cloud sync | `Bruno.Bruno` |
| **Docker Compose** | Ships with Docker Desktop | — |

Installed via CLI rather than winget:

```bash
dotnet tool install --global dotnet-ef        # EF Core migrations
npm install -g @openapitools/openapi-generator-cli   # or use NSwag
```

**TablePlus** is a nicer Postgres client than DBeaver but is paid. DBeaver is fine; upgrade only if you spend real time in it.

---

## 5. Phase D — Mobile (Phase 2, ~month 7)

### Android — straightforward on Windows

| Tool | Why | winget ID |
|---|---|---|
| **Android Studio** | SDK, platform tools, emulator, `adb` | `Google.AndroidStudio` |
| **JDK 17** | Bundled with Android Studio | — |

Enable hardware acceleration (WHPX or Hyper-V) for a usable emulator, or just use a physical Android phone over USB — faster, and closer to reality for push testing.

### iOS — the real constraint

**You cannot build or debug iOS apps on Windows.** Xcode is macOS-only, and there is no legitimate workaround. Here is what is and is not possible:

| Task | Windows only? | How |
|---|---|---|
| Write the code | ✅ Yes | It is the same TypeScript as Android |
| Run on a physical iPhone | ✅ Yes | Expo Go for early work; EAS development builds installed via TestFlight later |
| **Build an .ipa** | ✅ Yes | **EAS Build** compiles on Expo's cloud Macs |
| **Submit to App Store** | ✅ Yes | **EAS Submit** |
| iOS Simulator | ❌ No | macOS only |
| Native module debugging | ❌ No | Requires Xcode |
| Xcode-level crash symbolication | ❌ Mostly no | Sentry covers most of it |

**This is precisely why the stack picked Expo/EAS** (Tech Stack §5.1) — cloud builds mean you can ship an iOS app from Windows. For most of Phase 2 you will be fine with a physical iPhone plus EAS.

**When a Mac becomes unavoidable:** during Sprint 2.4, the push pipeline. Notification Service Extensions, background fetch behaviour, and APNs edge cases are where Windows-only development stops being merely inconvenient. You *can* get through it with EAS builds and device logs, but each debug cycle becomes a 10-minute cloud build instead of a 30-second local one — and push is already the fiddliest work in the project.

**Recommendation:** buy a **Mac Mini (M4, 16 GB)** — roughly **₹60,000–75,000** in India — at the **start of Phase 2**, not before. It is the cheapest Mac that comfortably runs Xcode, it doubles as a build machine, and you can run it headless over screen sharing. Buying it 7 months into the project rather than on day one keeps ₹70k in the business for over half a year.

Cloud Mac rental (MacinCloud, MacStadium) runs roughly ₹2,500–8,000/month. It pencils out worse than buying if you need it for more than about 10 months, and Phase 2 onward is indefinite. Buy.

### Mobile tooling

```bash
npm install -g eas-cli
```

Plus **Expo Go** on your physical iPhone and Android phone.

**Apple Developer Program: $99/year (~₹8,500).** Enrol at the *start* of Phase 2 — approval for a business entity can take one to two weeks and occasionally requires a D-U-N-S number, which is its own delay. Google Play is a one-time $25.

---

## 6. Phase E — Operations (Phase 3–4)

| Tool | Why | winget ID |
|---|---|---|
| **Terraform** | VMs, DNS, storage as code | `Hashicorp.Terraform` |
| **Bitwarden** | Secrets and credential storage | `Bitwarden.Bitwarden` |
| **WinSCP** | Occasional file transfer to servers | `WinSCP.WinSCP` |

Cloud services, nothing to install: Sentry, BetterStack (uptime + status page, with **SMTP and IMAP protocol checks, not just HTTP**), Grafana Cloud, PostHog.

Kubernetes tooling (`kubectl`, `k9s`, `helm`) is deliberately absent — Tech Stack §7 cuts K8s for v1. Add it if and when scaling pain is real.

---

## 7. Accounts to Create (mostly free, some with lead time)

| Account | Cost | Lead time | When |
|---|---|---|---|
| Domain registrar (test domain) | ~₹800/yr | minutes | Sprint 0.1 |
| Hosting — Hetzner or OVH | ~₹2,000/mo | **hours to days** — verify port 25 and rDNS in writing first | Sprint 0.1 |
| Relay — SES / Postmark / Resend | usage-based | **SES sandbox exit takes days** | Sprint 0.2 |
| Google Postmaster Tools | free | minutes | Sprint 0.2 |
| Microsoft SNDS | free | **days** — manual approval | Sprint 0.2 |
| GitHub | free | minutes | Sprint 0.1 |
| Cloudflare R2 or Backblaze B2 | usage-based | minutes | Sprint 1.5 |
| Expo / EAS | free tier, then $19/mo | minutes | Sprint 2.2 |
| **Apple Developer** | **$99/yr** | **1–2 weeks** | **Start of Phase 2 — enrol early** |
| Google Play Console | $25 once | days | Sprint 2.2 |
| Razorpay | ~2% per txn | **1–2 weeks KYC** | Phase 3 |
| Sentry | free tier | minutes | Sprint 2.5 |

**The three with real lead time — SNDS, Apple Developer, Razorpay KYC — should be started well before you need them.** Each has blocked someone's launch for a fortnight.

---

## 8. Hardware

| | Minimum | Comfortable |
|---|---|---|
| RAM | 16 GB | **32 GB** |
| Storage | 512 GB SSD | 1 TB NVMe |
| CPU | 6 cores | 8+ cores |

32 GB is the honest recommendation, not a luxury. A realistic Phase 1 session has WSL2 with Docker running Postgres, Redis, Postfix, Dovecot and Rspamd, plus a .NET build, a Next.js dev server, VS Code, and a browser with 30 tabs. 16 GB will run it; it will also swap, and you will feel it every day for a year.

Cap WSL2's memory so it does not consume everything — create `C:\Users\amitd\.wslconfig`:

```ini
[wsl2]
memory=16GB
processors=6
swap=8GB
localhostForwarding=true
```

Adjust to roughly half your physical RAM.

---

## 9. What You Do *Not* Need

Worth stating, because these get installed reflexively:

| Not needed | Why |
|---|---|
| XAMPP / WAMP | Wrong stack entirely |
| Native Postgres or Redis on Windows | Docker, always. Matches production |
| IIS | Kestrel behind Nginx/Caddy |
| Visual Studio 2026 (full) | VS Code covers it; Rider if you want more |
| Kubernetes tooling | Cut for v1 |
| RabbitMQ | Cut for v1 — Postgres `SKIP LOCKED` queue instead |
| OpenSearch locally | Cut for v1 — Postgres FTS |
| MinIO locally | Use R2/B2 dev buckets; do not self-host object storage |
| A separate Linux VM | WSL2 is better for this |

---

## 10. Verifying the Setup

Run through this after Phase A. Every line should print a version:

```powershell
git --version
wsl --status
docker --version ; docker compose version
dotnet --version          # expect 10.x
node --version            # expect 22.x
pnpm --version
```

And inside WSL:

```bash
dotnet --version
node --version
pnpm --version
dig +short google.com
swaks --version
docker ps                 # Docker Desktop WSL integration working
```

**The real Phase A test** is not a version number. It is this:

```bash
mkdir -p ~/code/tatvaos-mail && cd ~/code/tatvaos-mail
docker run --rm -d --name pgtest -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17
psql -h localhost -U postgres -c "SELECT version();"
docker stop pgtest
```

If that works from inside WSL, connects from a Windows DBeaver session, and the repo lives on the WSL filesystem, your environment is correct and you can start Sprint 0.1.

---

*Install Phase A today. Everything else waits until the delivery plan calls for it — tooling installed months before use is tooling that will be out of date, half-remembered, and blamed for the first bug you hit.*
