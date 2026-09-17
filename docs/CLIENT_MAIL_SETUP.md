# Using your TatvaOS mailbox from other software

*The one-page sheet a client receives. Everything on it is served live at
core.tatvaos.com/platform; this copy exists so it can be attached to an
email. (Until 17 Sept 2026 it said platform.tatvaos.com; that address now
redirects to the same page, and stays answering because copies of this sheet
already sit in clients' inboxes.)*

---

Your TatvaOS mailbox works with any standard mail application — Outlook,
Thunderbird, Apple Mail, a phone's built-in mail app — and with software
that sends mail on your behalf, such as an ERP or a school-management
system.

## The settings

| | |
|---|---|
| **Incoming mail (IMAP)** | `mail.tatvaos.com` — port **993** — SSL/TLS |
| **Outgoing mail (SMTP)** | `mail.tatvaos.com` — port **587** — STARTTLS |
| **Username** | your full email address (e.g. `accounts@yourschool.com`) |
| **Password** | an **app password** — see below |

## The app password

Do **not** enter your TatvaOS sign-in password into other software. Instead:

1. Sign in to TatvaOS Mail in your browser.
2. Open **Settings → App passwords**.
3. Name the device or software (e.g. "Tally on office PC") and press
   **Generate**.
4. Copy the password it shows — **it is shown exactly once** — and paste it
   into your software's password field.

The app password opens only your mailbox. It cannot sign in to TatvaOS, and
you can revoke it at any moment without changing anything else. If it is
ever lost or a device is stolen, generate a new one — the old one stops
working immediately.

## If something doesn't connect

- The **username is the full address**, including everything after the @.
- Port **993 must say SSL/TLS**, and port **587 must say STARTTLS** — mail
  apps sometimes guess these wrong.
- If your software offers "plain" or "unencrypted" connections, they are
  refused by design; choose the encrypted option.

Anything else: support@tatvaos.com.
