# Importing mail to TatvaOS using Thunderbird

A step-by-step guide for migrating your email from Gmail, Outlook, or another provider to TatvaOS Mail. Takes about 20 minutes.

You will need:
- **Thunderbird** (free, download from mozilla.org)
- Your **old email address and password**
- A **TatvaOS app password**. To make one, sign in to TatvaOS Mail in your browser, open **Settings → App passwords**, give it a name (e.g. "Thunderbird import") and press **Generate**. It is shown **once**, so copy it straight away.

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
   - **Password** — your Gmail/Outlook password
3. Click **Continue**
4. Thunderbird will auto-detect the settings and show them
5. Click **Done**
6. For **Gmail** and **Outlook.com**, Thunderbird usually opens Google's or Microsoft's own sign-in window at this point. Sign in there, and allow Thunderbird access when asked.

You should now see your old email account in the left sidebar with all your folders underneath.

---

## Step 3: Add your TatvaOS Mail account

1. Click **File** → **New** → **Existing Mail Account** again
2. Enter:
   - **Your name** (any name; this is for display only)
   - **Email address** — your TatvaOS email (e.g., `accounts@yourschool.com`)
   - **Password** — your **TatvaOS app password** (NOT your sign-in password)
3. Click **Continue**
4. When settings appear, click **Configure manually** and check them:
   - **Incoming (IMAP):** `mail.tatvaos.com` port **993** with **SSL/TLS**
   - **Outgoing (SMTP):** `mail.tatvaos.com` port **587** with **STARTTLS**
   - **Username** (both): your **full** TatvaOS email address
5. Click **Done**

You should now see your TatvaOS account in the left sidebar.

---

## Step 4: Copy your mail over

In the left sidebar, you now have two accounts. Copy one folder at a time:

1. In your **old account**, click **Inbox** (or the folder you want to copy) so its messages show
2. Click any message in the list, then press **Ctrl+A** (**Cmd+A** on a Mac) to select them all
3. Right-click the selected messages → **Copy To** → your **TatvaOS account** → **Inbox**

Thunderbird copies the messages, and the bottom of the window shows the progress. This may take a few minutes depending on how much mail you have. The messages stay in your old account too: this is a copy, not a move.

**Repeat for other folders:**
- Sent → Sent (in Gmail it is called **Sent Mail**, under **[Gmail]**)
- Drafts → Drafts
- Any folders you made yourself: first create a folder with the same name in your TatvaOS account (right-click the account → **New Folder**), then copy into it

**For Gmail, do not copy "All Mail".** It holds every message again, including your Inbox and Sent, so copying it would give you everything twice. Gmail's labels show up as folders; copy the ones you want.

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
- **For your TatvaOS account:** use a TatvaOS **app password**, not your TatvaOS sign-in password, and your **full** email address as the username. If you have lost the app password, make a new one in TatvaOS Mail (**Settings → App passwords**). The old one stops working.
- **For your old Gmail/Outlook account:** if Google's or Microsoft's sign-in window did not appear, your provider may need an *app password* for Thunderbird instead of your normal password.
  - **Gmail:** myaccount.google.com → **Security** → **2-Step Verification** → **App passwords**. This only appears once 2-Step Verification is on.
  - **Outlook.com:** account.microsoft.com → **Security** → **Advanced security options** → **App passwords**
  - A **work or school** Microsoft or Google account may not allow this. Ask that organisation's IT administrator.
- Delete the account from Thunderbird and add it again with the app password

**"The copy stopped, saying the mailbox is full or over quota"**
- Your TatvaOS mailbox has a storage limit set by your organisation's plan. Ask your TatvaOS administrator for more space, or copy only the folders you need.

**"The copy is very slow"**
- That's normal for large mailboxes. Let it run. Don't close Thunderbird.

**"Some messages didn't copy"**
- If a message is corrupted or extremely large, Thunderbird may skip it
- These are rare. Check the count in Thunderbird vs. your webmail — if it's close, you're done
- If many are missing, contact support@tatvaos.com

**"I see the messages in Thunderbird but not in the webmail"**
- Wait a few minutes — Thunderbird syncs in the background
- Then reload the webmail page
- If they still don't appear, check that you're looking at the right account, and that you copied into the **TatvaOS** account, not into Thunderbird's **Local Folders**

---

## After import: use TatvaOS Mail going forward

You can now:
- Keep using Thunderbird (it will stay in sync with TatvaOS)
- Use the webmail at **mail.tatvaos.com**
- Set up other devices (phone, tablet) with the settings sheet at **core.tatvaos.com/platform**: the same server names and ports as above, and a separate app password for each device
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
