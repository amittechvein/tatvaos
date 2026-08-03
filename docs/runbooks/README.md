# Runbooks

Write these before GA, not after the first outage.

Format: **symptom → diagnosis → fix → confirm**.

## Needed before taking paying customers

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
- [ ] Disk full on the mail edge
