# DKIM keys

`*.key` files here are **private keys and are gitignored**. Committing one means
rotating DKIM for every domain that uses it, and until you do, anyone with the
repo can sign mail as you.

## Current key

| | |
|---|---|
| Selector | `tv2026a` |
| Algorithm | RSA 2048 |
| Public part | `tv2026a.pub` (safe to commit) |
| Private part | `tv2026a.key` (**never commit**) |

The selector encodes the year and a letter, so rotation is obvious: the next key
is `tv2026b`. Publish the new public record, run both selectors in parallel for a
week so mail already in flight still verifies, then switch signing over and
retire the old one.

## Why 2048 and not 4096

A 4096-bit public key exceeds the 255-character limit of a single DNS TXT string
and has to be split into multiple quoted chunks. Plenty of DNS panels handle that
badly. 2048 is the practical choice and is what most large senders use.

## On the server

```bash
sudo install -o root -g root -m 600 tv2026a.key /etc/rspamd/dkim/tatvaos.com.key
```

Back it up somewhere that is not this repo — Bitwarden is already installed.
Losing it means every message signed with `tv2026a` stops verifying.
