# docs/

| Folder | Contents |
|---|---|
| `architecture/` | How the system works and why |
| `setup/` | Getting a machine ready to develop |
| `runbooks/` | ★ What to do when something is broken |
| `decisions/` | ADRs — why we chose X over Y |

## Reading order for a new developer

1. `/README.md` — the repo map
2. `setup/01-dev-environment.md` — get your machine working
3. `/local/README.md` — run mail locally
4. `architecture/01-architecture.md` — how it works
5. `architecture/03-delivery-plan.md` — what is next

## runbooks/

Write these **before** the first outage, not during it. At 3am, under pressure, with customers waiting, is not when you want to be reasoning from first principles about how DKIM key rotation works.

Each runbook: symptom → diagnosis → fix → how to confirm it worked.

## decisions/

One short file per significant choice. Context, options considered, what we picked, why, and what would make us revisit. Future you will not remember the reasoning, and a new developer has no way to reconstruct it.
