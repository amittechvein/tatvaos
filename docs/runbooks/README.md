# Runbooks

Write these before GA, not after the first outage.

Format: **symptom → diagnosis → fix → confirm**.

## Needed before taking paying customers

- [x] [Postfix/Dovecot config errors](01-mail-edge-config-errors.md)
- [x] [Billing: encrypted secrets, the rollback floor, refunds](billing-secrets-and-rollback.md)
- [ ] Mail queue backing up
- [ ] Delivery latency above SLA
- [ ] Blocklist entry appeared — delisting procedure
- [ ] DKIM key rotation
- [ ] APNs `.p8` key expiry (breaks push silently and completely)
- [ ] TLS certificate renewal failure
- [ ] Database failover
- [ ] Restore from backup — with the last drill date recorded
- [ ] Tenant reports missing mail
- [ ] Suspected compromised tenant account
- [ ] Abuse report received at `abuse@`
- [x] [Capacity and disk — measured numbers, and when to spend money](capacity.md)
- [ ] Disk full on the mail edge
