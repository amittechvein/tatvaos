# Cloud Environments — Testing and Production

**Decision:** the platform runs on Linode.

> **Current state — ONE box, and it is production.**
>
> `172.105.57.198` began as staging and has been promoted. `core.`, `mail.`,
> `mx.` and `staging.` all resolve to it; `staging.` now 308-redirects to
> `core.`. There is no separate testing environment, which means **there is no
> longer anywhere to try a change before customers see it** — the local Docker
> stack in `local/` is the only safety net, and it is a weaker one because it
> does not exercise real DNS, real TLS or real SMTP.
>
> Restore the second environment before onboarding a customer who would notice
> a bad deploy. Everything below describes the two-environment design and stays
> accurate for the day the testing box comes back.

Two environments, deployed the same way, differing only where they must.

---

## Production hostnames — one per product

TatvaOS Core is the console; every product is a separate front door beneath the
same identity. The naming follows Google's, because customers already know it:

| | TatvaOS | Google equivalent |
|---|---|---|
| **Core** — the admin console | `core.tatvaos.com` | `admin.google.com` |
| **Mail** — webmail | `mail.tatvaos.com` | `mail.google.com` |
| Marketing site | `tatvaos.com` | — |
| Staging (everything) | `staging.tatvaos.com` | — |
| **Mail exchanger** | `mx.tatvaos.com` | `aspmx.l.google.com` |

Three things follow from this that are easy to get wrong:

1. **`mail.tatvaos.com` is the WEB app, not the MX host.** The mail exchanger is
   `mx.tatvaos.com`. Customers publish `MX 10 mx.tatvaos.com` — never
   `mail.tatvaos.com`. Keeping them separate means the webmail host can move to
   a CDN or a different box without touching anyone's DNS.

2. **`mail.tatvaos.com` currently resolves to Bluehost** (`162.214.80.55`), left
   over from the old hosting. It has to be repointed at the Linode before
   webmail can live there, and repointing it will break whatever mail service is
   using it today. Check that first.

3. **One cookie domain, several hosts.** Core and Mail share a session, so the
   auth cookies are issued for `.tatvaos.com` in production rather than for a
   single host. `SameSite=Strict` still holds — `core.` and `mail.` are the same
   site — but the API must be reachable at the same registrable domain, so it
   sits behind `core.tatvaos.com/api` rather than on a separate `api.` host with
   its own cookie scope.

---

## The two environments

| | **Testing** | **Production** |
|---|---|---|
| Domain | `staging.tatvaos.com` | `core.tatvaos.com` (see below) |
| **Outbound mail** | **Captured — cannot leave the box** | **Reaches the real internet** |
| Webmail for testers | Roundcube exposed | Not present |
| Mail catcher | Mailpit exposed | Not present |
| Database port | Loopback only, via SSH tunnel | **Not published at all** |
| Mail ports | Shifted — 2525, 5870, 1143 | Real — 25, 587, 143, 993 |
| Seed data | Four fake tenants | Real customers only |
| Memory limits | Small | Sized for load |
| Log retention | Default | Rotated, 10 files |

**The first row is the one that matters.** A test environment that can email real people will eventually email real people. In testing, Postfix relays to Mailpit exactly as the local stack does — testers can send to any address they like and it lands in a web inbox.

### How the difference is expressed

One base file with the service definitions, plus a per-environment overlay:

```
infra/docker/
├── docker-compose.base.yml         shared — identical in both
├── docker-compose.testing.yml      containment, testers' tools, small limits
├── docker-compose.production.yml   real ports, no catcher, real limits
├── Caddyfile                       automatic TLS, same file for both
├── .env.testing.example
└── .env.production.example
```

Keeping the base free of environment specifics means both run the **same service definitions**. That is the only way a passing test means anything about production.

---

## Deploying

**Machine:** the target server · **Directory:** the repo checkout

```bash
./infra/scripts/deploy.sh testing
./infra/scripts/deploy.sh production
```

The script refuses to proceed if:

- `.env` is missing or still contains `CHANGE_ME`
- the server's `/etc/tatvaos-environment` disagrees with the environment you named
- the pre-deploy database backup fails

That middle check is worth explaining. Deploying the testing overlay to production would silently switch off outbound containment; deploying production config to the test box would let test mail reach real people. Both are one typo away, so mark each server once:

```bash
echo testing | sudo tee /etc/tatvaos-environment
```

Production deploys additionally require typing `production` to confirm, because the consequence — mail reaching real inboxes — is not reversible.

---

## Servers and cost

| | Spec | Monthly |
|---|---|---|
| Testing | 4 GB / 2 vCPU | ~$24 |
| Production | 4 GB / 2 vCPU, later 8 GB | ~$24, later ~$48 |
| **Total** | | **~$48** |

Your current instance is **1 GB**, which will not run this. Postgres, Redis, Postfix, Dovecot, the API, the web app and Caddy together need 4 GB minimum. Linode resizing is a few minutes plus a reboot and the disk grows with it, so starting small cost nothing.

### One box or two?

Two is correct, but honestly: while there are **no customers**, one 8 GB box running both stacks on separate networks and ports works and costs half.

The reason to separate before your first paying customer is not tidiness. On one box they share a kernel, a disk and a resource pool — a runaway test process can take production down, and you cannot test an OS upgrade without risking the thing you are testing it for. Separate them at the Phase 3 gate at the latest.

---

## What you can remove from your machine

This is what you actually asked. Assuming development moves to the server via **VS Code Remote-SSH** — you edit files on the Linode, and they build and run there.

### Can be removed

| Tool | Reclaims | Why it becomes unnecessary |
|---|---|---|
| **Docker Desktop** | ~4 GB disk, **8 GB RAM** | Containers run on the server. This is the big one on a 16 GB machine |
| **Android Studio** | ~12 GB | Not needed until Phase 2, around month 7. Reinstall then |
| **DBeaver** | ~500 MB | Adminer on the testing box, over an SSH tunnel |
| **Thunderbird** | ~200 MB | Roundcube on the testing box does the same job |
| **Bruno** | ~300 MB | The OpenAPI page at `/openapi` covers most of it |
| **PowerToys, 7-Zip, Firefox** | ~1 GB | Convenience, never required |
| **cloudflared** | small | Only needed to tunnel webhooks *to* localhost. With no localhost, no tunnel |

**Roughly 18 GB of disk and 8 GB of RAM back.** The RAM is the real prize — your WSL allocation was capped at 8 GB of 16 GB.

### Must stay

| Tool | Why |
|---|---|
| **VS Code** + Remote-SSH extension | This becomes your entire development environment |
| **Git** | Version control is local regardless |
| **Windows Terminal / PowerShell** | You still need a shell |
| **Tailscale** | Reach the servers without exposing SSH to the internet. More important now, not less |
| **Bitwarden** | The DKIM key and every production secret |

### Optional, and worth keeping

| Tool | Why keep it |
|---|---|
| **WSL2** | You lose almost nothing by keeping it and it gives you a real `ssh`, `dig`, `swaks` and `scp`. Removing Docker Desktop already reclaims the RAM |
| **.NET SDK / Node.js** | Only if you ever want to run something locally. Small, and they make a build failure diagnosable without a deploy |

---

## The honest trade

Cloud-only development is a real pattern and it will free up your machine. It also has costs worth knowing before you commit:

**What gets worse**

- **Iteration speed.** Local edit-and-reload is instant. Remote-SSH is fast but a container rebuild is 30–90 seconds, and you will do that many times a day.
- **You need reliable internet.** No connection, no work — not a smaller amount of work.
- **Debugging is harder.** Attaching a debugger over SSH is possible and it is more friction than F5.
- **Cost goes from ₹0 to about ₹4,000/month.**

**What gets better**

- One environment, not two. The "works on my machine" class of bug disappears.
- Testers hit a URL rather than installing Docker.
- Your laptop stops running five containers.
- Production and testing are configured identically, so testing tells you something real.

### What I would do

**Keep local development, move testing and production to the cloud.**

Concretely: remove **Android Studio** (12 GB, not needed for seven months) and keep everything else for now. Deploy the testing environment to Linode so testers and demos have a URL. Revisit removing Docker Desktop once you have actually worked remotely for a week and know whether the slower loop bothers you.

The reason is that the loop you are in right now — write code, run the mail stack, watch it break, fix it — is exactly the loop that suffers most from a 60-second deploy between every attempt. We hit four config bugs today that took seconds to fix locally. Each would have been a deploy cycle.

That said, it is your call and the machine is yours. If you want cloud-only, the deployment is built and works either way — nothing in the repo assumes local development.

---

## Getting there

1. **Resize the Linode to 4 GB** — Cloud Manager, a few minutes plus a reboot
2. **DNS:** `A staging.tatvaos.com → 172.105.57.198`
3. On the server:

```bash
git clone <your-repo> tatvaos && cd tatvaos
cp infra/docker/.env.testing.example infra/docker/.env
# fill in every CHANGE_ME — openssl rand -base64 32
echo testing | sudo tee /etc/tatvaos-environment
./infra/scripts/deploy.sh testing
```

Caddy obtains the TLS certificate automatically on first request. No certbot, no cron job, no expiry incident at 3am.

**Testing does not need the SMTP unblock.** Internal mail — tenant to tenant, which is most of what testers exercise — never touches port 25 outbound. Staging can be live while that ticket is still open.
