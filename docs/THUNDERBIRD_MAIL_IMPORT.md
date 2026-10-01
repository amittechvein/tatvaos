# Importing mail to TatvaOS using Thunderbird

A step-by-step guide for migrating your email from Gmail, Outlook, or another provider to TatvaOS Mail. Takes about 20 minutes.

You will need:
- **Thunderbird** (free, download from mozilla.org)
- Your **old email address and password** (or app password if the provider uses one)
- Your **TatvaOS app password** (generated in TatvaOS Mail settings)

---

## Step 1: Download and install Thunderbird

1. Go to **mozilla.org/thunderbird** (or search "Thunderbird download")
2. Click **Download**
3. Install it (Windows/Mac/Linux)
4. Open Thunderbird

---

## Step 2: Add your old email account

In Thunderbird:

1. Click **File** → **New** → **Existing Mail Account**
2. Enter:
   - **Your name** (any name you like; it's for display only)
   - **Email address** — your old Gmail or Outlook address
   - **Password** — your Gmail/Outlook password (or app password if they use one)
3. Click **Continue**
4. Thunderbird will auto-detect the settings and show them
5. Click **Done**

You should now see your old email account in the left sidebar with all your folders underneath.

---

## Step 3: Add your TatvaOS Mail account

1. Click **File** → **New** → **Existing Mail Account** again
2. Enter:
   - **Your name** (any name; this is for display only)
   - **Email address** — your TatvaOS email (e.g., `accounts@yourschool.com`)
   - **Password** — your **TatvaOS app password** (NOT your sign-in password)
3. Click **Continue**
4. When settings appear, change:
   - **Incoming (IMAP):** `mail.tatvaos.com` port **993** with **SSL/TLS**
   - **Outgoing (SMTP):** `mail.tatvaos.com` port **587** with **STARTTLS**
5. Click **Done**

You should now see your TatvaOS account in the left sidebar.

---

## Step 4: Copy your mail over

In the left sidebar, you now have two accounts. Time to copy:

1. In your **old account**, right-click on **Inbox** (or any folder you want to copy)
2. Select **Copy**
3. In your **TatvaOS account**, right-click on **Inbox**
4. Select **Paste**

Thunderbird will copy all the messages. A progress bar will appear. This may take a few minutes depending on how much mail you have.

**Repeat for other folders:**
- Drafts → Drafts
- Sent → Sent
- Any custom folders → copy them too

---

## Step 5: Verify it worked

1. In your **TatvaOS account**, click on **Inbox**
2. You should see all your messages
3. Click on a message to read it — it should show the full body, attachments, etc.
4. Open **mail.tatvaos.com** in your browser and sign in
5. Click **Inbox** in the webmail — you should see the same messages

---

## If something goes wrong

**"Thunderbird is asking for a password over and over"**
- You may have entered your Gmail/Outlook *sign-in* password instead of an *app password*
- Gmail and Outlook require special app passwords for third-party apps like Thunderbird
- For **Gmail:** go to myaccount.google.com → Security → App passwords (you may need 2-factor on)
- For **Outlook:** go to account.microsoft.com → Security → App passwords
- Delete the account from Thunderbird and add it again with the app password

**"The copy is very slow"**
- That's normal for large mailboxes. Let it run. Don't close Thunderbird.

**"Some messages didn't copy"**
- If a message is corrupted or extremely large, Thunderbird may skip it
- These are rare. Check the count in Thunderbird vs. your webmail — if it's close, you're done
- If many are missing, contact support@tatvaos.com

**"I see the messages in Thunderbird but not in the webmail"**
- Wait a few minutes — Thunderbird syncs in the background
- Then sign out of the webmail, close your browser, and sign back in
- If they still don't appear, check that you're looking at the right account

---

## After import: use TatvaOS Mail going forward

You can now:
- Keep using Thunderbird (it will stay in sync with TatvaOS)
- Use the webmail at **mail.tatvaos.com**
- Set up other devices (phone, tablet) using the settings in `CLIENT_MAIL_SETUP.md`
- Delete the old email account from Thunderbird if you want (it stays on Gmail/Outlook unless you delete it there too)

To avoid confusion, **update the email forwarding on your old account** to send new mail to your TatvaOS address:
- **Gmail:** Settings → Forwarding and POP/IMAP → Add forwarding address
- **Outlook:** Settings → Mail → Forwarding → Turn on

Then all new mail arrives in TatvaOS while you keep your old archive for reference.

---

## Questions?

Contact **support@tatvaos.com** with:
- Your TatvaOS email address
- How many messages you're trying to copy
- What error you see, if any
