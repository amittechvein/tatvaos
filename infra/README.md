# infra/ — configured, not coded

| Folder | Contents |
|---|---|
| `postfix/` | `main.cf`, `master.cf`, SQL lookup files, milters |
| `dovecot/` | `dovecot.conf`, SQL auth config, plugins |
| `rspamd/` | Spam filtering rules |
| `docker/` | Production compose files |
| `terraform/` | Servers, DNS, storage buckets as code |
| `dns/` | Record templates given to customers for their domains |

## Never write an MTA

This is the single highest-leverage "don't build it" decision in the product. Postfix and Dovecot have absorbed twenty years of interoperability edge cases — malformed MIME, 8BITMIME, pipelining, BDAT, odd TLS stacks. A hand-rolled MTA passes your tests and fails against the real internet, one angry customer at a time.

Custom logic goes in **milters** (`postfix/milters/`) and **Dovecot plugins** (`dovecot/plugins/`) that call our API. That is the correct integration seam.

## Relationship to `local/`

`local/` is the development stack with the same config shaped for Docker, plus a relayhost that keeps mail off the internet. When you change a Postfix or Dovecot setting, change it in **both** — or it works locally and breaks in production.

## No hand-edited servers

Every configuration change lands here and is committed. If you cannot rebuild the mail edge from this folder in under an hour, something has drifted.
