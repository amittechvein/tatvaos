# CI/CD and Server Topology

**Your proposed workflow, implemented — with one change to the server layout that I'd argue for.**

```
Laptop (coding only)
   ↓  git push
GitHub Actions — CI
   ↓  green
Testing environment          app-test.tatvaos.com
   ↓  QA sign-off
Production (manual)          core.tatvaos.com
```

---

## The pipeline

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Every push and PR | Frontend build, backend build, **tenant isolation**, mail stack |
| `deploy-testing.yml` | Green `main`, automatic | Deploys to testing, smoke-tests it |
| `deploy-production.yml` | **Manual only** | Typed confirmation + GitHub environment approval |

**Testing deploys itself. Production does not.** Production is the only environment where outbound mail reaches real inboxes and the data belongs to paying customers — a deploy there is a decision, not a consequence of merging.

The isolation job in CI blocks the merge. It runs against a real PostgreSQL because RLS does not exist in an in-memory provider: every test would pass and prove nothing.

---

## The one change I'd argue for

Your layout puts both environments on one VPS:

```
Linode (one VPS)
├── Testing    ├── db-test    └── mail-test
└── Production ├── db-prod    └── mail-prod
```

**For the web app, API and databases this is fine.** Separate containers, separate networks, separate volumes, separate credentials. At your stage it is a reasonable saving and I would not object.

**For mail it does not work, and the reason is specific rather than general caution.**

### One VPS has one IP, and mail is bound to the IP

A mail server's identity is its IP address, not its hostname. Three things are fixed per IP:

| | |
|---|---|
| **PTR record** | One per IP. It must match the `EHLO` hostname or receivers treat the mismatch as a spam signal. `mail-test` and `mail-prod` cannot both own it |
| **Port 25** | One listener per IP. Two Postfix instances cannot both bind it |
| **Reputation** | Gmail and Outlook score the **IP**. Test traffic and customer traffic would share one reputation |

That last row is the one that costs money. A tester loops a send script, complaint rate rises, and Gmail throttles the IP your paying customers depend on. You would have no way to tell the two apart because to Gmail they are the same sender.

### The fix is small

Keep your layout, add a second IP:

```
Linode VPS  (8 GB)
│
├── Primary IP    172.105.57.198   PTR mail.tatvaos.com
│   └── Production     core.tatvaos.com  mail.tatvaos.com  mx.tatvaos.com  db-prod
│
└── Second IP     <assigned>       PTR mail-test.tatvaos.com
    └── Testing        app-test.tatvaos.com   api-test.tatvaos.com   db-test   mail-test
```

A second IPv4 on Linode is about **$2/month** and is requested from Cloud Manager. Each Postfix binds its own address, each gets its own PTR, and reputations stay separate.

Cheaper still: **testing does not need to send externally at all.** It relays to Mailpit, which is how the testing overlay is already configured. Under that arrangement one IP is genuinely fine, because only production ever talks to the internet.

**My recommendation:** one 8 GB VPS, both environments, testing contained to Mailpit, and no second IP until testing genuinely needs to send outbound. That is your layout, unchanged, with one constraint written down.

### When to split into two VPSs

Not now. At the **Phase 3 gate**, before the first paying customer. On one box they share a kernel, a disk and a resource pool — a runaway test process can take production down, and you cannot test an OS upgrade without risking the thing you are testing it for.

---

## DNS

| Record | Value | Purpose |
|---|---|---|
| `core.tatvaos.com` | A → VPS IP | Production — TatvaOS Core console |
| `mail.tatvaos.com` | A → VPS IP | Production — TatvaOS Mail webmail |
| `mx.tatvaos.com` | A → VPS IP | Mail exchanger. **PTR must match this.** |
| `api.tatvaos.com` | A → VPS IP | Production API |
| `mail.tatvaos.com` | A → VPS IP | Production MX host |
| `app-test.tatvaos.com` | A → VPS IP | Testing web |
| `api-test.tatvaos.com` | A → VPS IP | Testing API |
| `tatvaos.com` | MX 10 → mail.tatvaos.com | Inbound mail |

`db-test` and `db-prod` get **no DNS records**. They are container names on private Docker networks and must never be reachable from the internet.

---

## Server setup, once

**Machine:** the Linode · **Directory:** `/srv`

```bash
# A deploy user that is not root
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
# paste the CI public key
nano /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

# Two checkouts, two environments
mkdir -p /srv/tatvaos-testing /srv/tatvaos-production
chown deploy:deploy /srv/tatvaos-*

su - deploy
git clone <repo> /srv/tatvaos-testing
git clone <repo> /srv/tatvaos-production

# Mark each so a wrong-environment deploy is refused
echo testing    | sudo tee /srv/tatvaos-testing/.environment
echo production | sudo tee /srv/tatvaos-production/.environment

# Secrets — different values in each, never committed
cp /srv/tatvaos-testing/infra/docker/.env.testing.example \
   /srv/tatvaos-testing/infra/docker/.env
cp /srv/tatvaos-production/infra/docker/.env.production.example \
   /srv/tatvaos-production/infra/docker/.env
# fill in every CHANGE_ME:  openssl rand -base64 32
```

---

## GitHub secrets

**Settings → Secrets and variables → Actions**

| Secret | Value |
|---|---|
| `TESTING_HOST` | VPS IP or hostname |
| `PRODUCTION_HOST` | Same VPS for now |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | Private key whose public half is in `authorized_keys` |

Generate a dedicated key — do not reuse your personal one:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key -N ""
```

**Settings → Environments → production → Required reviewers: yourself.**

The typed `production` confirmation is a speed bump. The environment approval is a second deliberate act, and it is what stops a 2am deploy that felt fine at the time.

---

## What this means for your laptop

Once CI/CD is running, the laptop genuinely only needs:

| Keep | Why |
|---|---|
| VS Code | Editing |
| Git | Push is now the deploy trigger |
| Terminal | Shell |
| Tailscale | Reach the servers privately |
| Bitwarden | Secrets |

**Removable:** Docker Desktop (~4 GB, 8 GB RAM), Android Studio (~12 GB until month 7), DBeaver, Thunderbird, Bruno.

One honest caveat, unchanged from before: CI takes three to five minutes. While you are still debugging mail config — and today produced four such bugs — a local stack turns that into seconds. Keep Docker Desktop until Phase 0 closes, then remove it.
