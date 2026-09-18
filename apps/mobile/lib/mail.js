/**
 * The Mail endpoints this app needs, ported from apps/web/lib/mail.ts.
 *
 * Everything goes through `request` in api.js, for the reason its opening
 * comment gives. The shapes below are the API's, not a translation: `isRead`
 * is `isRead` here as it is there, because a field renamed in the client is a
 * field somebody has to look up twice.
 *
 * ── WHAT THE API DOES NOT DO, AND THIS APP MUST ──────────────────────────
 *  • NO product gate. A person without Mail is not refused; they simply have
 *    no mailbox, and /bootstrap answers { mailbox: null, folders: [] }. That
 *    is an empty state to draw, not an error to report.
 *  • NO sanitisation. bodyHtml is the sender's HTML, untouched. The web app
 *    sanitises with DOMPurify and an iframe; the phone renders inside a
 *    WebView with JavaScript OFF and a content policy that blocks remote
 *    images until asked (screens/MailMessage.js).
 *  • Attachments are NOT saved with a draft (MailEndpoints.cs), so a draft
 *    saved from the phone loses them, and the compose screen says so.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { File } from 'expo-file-system';

import { request, API_BASE } from '../api';

/** Mailbox, folders and signature in one call — what the app opens Mail with. */
export async function bootstrap(token) {
  const data = await request('/api/mail/bootstrap', { method: 'GET', token });
  return {
    mailbox: data?.mailbox ?? null,
    folders: data?.folders ?? [],
    signature: data?.signature ?? '',
  };
}

/** Folders with their unread counts. Cheaper than bootstrap for a refresh. */
export async function listFolders(token) {
  const data = await request('/api/mail/folders', { method: 'GET', token });
  return data?.folders ?? [];
}

/**
 * One page of a folder, newest first. Offset paging — the API takes skip/take
 * and clamps take to 100; there is no cursor.
 */
export async function listMessages(token, folderId, { skip = 0, take = 30 } = {}) {
  const data = await request(
    `/api/mail/folders/${folderId}/messages?skip=${skip}&take=${take}`,
    { method: 'GET', token },
  );
  return { total: data?.total ?? 0, messages: data?.messages ?? [] };
}

/** Search the whole mailbox. An empty query answers empty, not everything. */
export async function searchMessages(token, q, { skip = 0, take = 30 } = {}) {
  if (!q?.trim()) return { total: 0, messages: [] };
  const data = await request(
    `/api/mail/search?q=${encodeURIComponent(q.trim())}&skip=${skip}&take=${take}`,
    { method: 'GET', token },
  );
  return { total: data?.total ?? 0, messages: data?.messages ?? [] };
}

/** One message, with bodyHtml, bodyText and attachment metadata. */
export function getMessage(token, id) {
  return request(`/api/mail/messages/${id}`, { method: 'GET', token });
}

export function setRead(token, id, isRead) {
  return request(`/api/mail/messages/${id}/read`, { token, body: { isRead } });
}

export function setFlag(token, id, isFlagged) {
  return request(`/api/mail/messages/${id}/flag`, { token, body: { isFlagged } });
}

/**
 * Delete: the FIRST delete moves to Trash and answers
 * { deleted: false, movedTo }, the second (from Trash) removes it for good and
 * answers { deleted: true }. The screen says which happened, because "Deleted"
 * over a message that is still in Trash is a promise the app did not keep.
 */
export function deleteMessage(token, id) {
  return request(`/api/mail/messages/${id}`, { method: 'DELETE', token });
}

/**
 * Send. multipart/form-data, the same fields the web composer posts, because
 * the endpoint carries attachments and takes nothing else.
 *
 * `inReplyToId` is what makes a reply a reply rather than a new conversation.
 * A longer timeout than the default: this is the one call that can carry
 * megabytes up a phone's uplink.
 *
 * SentButNotFiled answers 200 with { id: null, warning } — sent, not filed in
 * Sent. Success, and the warning is worth showing; retrying would send twice.
 */
export async function send(token, {
  to, cc = '', subject = '', bodyText = '', bodyHtml = '', inReplyToId, draftId, files = [],
}) {
  const form = new FormData();
  form.append('to', to);
  if (cc) form.append('cc', cc);
  form.append('subject', subject);
  form.append('bodyText', bodyText);
  if (bodyHtml) form.append('bodyHtml', bodyHtml);
  if (inReplyToId) form.append('inReplyToId', inReplyToId);
  if (draftId) form.append('draftId', draftId);
  // ── ATTACHMENTS GO UP AS FILE OBJECTS, NOT { uri, name, type }. ─────────
  //  Every React Native example says to append { uri, name, type }, and it is
  //  what RN's own networking understands. Expo SDK 54+ replaces global fetch
  //  with its own (expo/src/winter/fetch), which builds the multipart body in
  //  JavaScript and accepts only strings, Blobs, and objects with bytes() —
  //  everything else throws "Unsupported FormDataPart implementation".
  //
  //  That arrived as a NETWORK failure ("Cannot reach TatvaOS") on the phone,
  //  18 Sept 2026: a send with no attachment answered 200 in half a second,
  //  and the same send with a 36 KB photo failed in 8 ms, which is the tell —
  //  nothing that crosses a network fails that fast.
  //
  //  expo-file-system's File is a Blob with bytes(), a name and a type, and it
  //  reads from disk natively. The 25 MB cap the compose screen enforces is
  //  what keeps bytes() from being a memory problem.
  // ───────────────────────────────────────────────────────────────────────
  for (const f of files) {
    if (!f?.uri) {
      console.log(`[mail] attachment has no uri, keys: ${Object.keys(f ?? {}).join(',')}`);
      throw new Error(`Could not read ${f?.name ?? 'that file'}. Attach it again.`);
    }
    form.append('files', new File(f.uri));
  }
  return request('/api/mail/send', { method: 'POST', token, form, timeoutMs: 120000 });
}

/** Where an attachment can be downloaded from. Needs the bearer token. */
export function attachmentUrl(messageId, attachmentId) {
  return `${API_BASE}/api/mail/messages/${messageId}/attachments/${attachmentId}`;
}

/** The special folder slugs the app treats as known places. */
export const SLUGS = ['inbox', 'sent', 'drafts', 'junk', 'trash'];

/** Inbox first, then the other known folders, then everything else by name. */
export function orderFolders(folders) {
  const rank = (f) => {
    const i = SLUGS.indexOf(f.slug);
    return i < 0 ? SLUGS.length : i;
  };
  return [...(folders ?? [])].sort((a, b) =>
    rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** The name to show for a message row: the sender's name, or their address. */
export function senderLabel(m) {
  const from = m?.from ?? {};
  return from.name?.trim() || from.email || 'Unknown sender';
}

/**
 * "14:32" today, "Tue" this week, "12 Sep" this year, "12 Sep 2025" before
 * that — the shorthand every mail app uses, and the only reason a date column
 * fits on a phone. `now` is a parameter so the checks can pin the clock.
 */
export function whenLabel(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = (now - d) / 86400000;
  if (days >= 0 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Addresses as the compose screen shows them: "a@x.com, b@y.com". */
export function addressList(people) {
  return (people ?? []).map((p) => p?.email).filter(Boolean).join(', ');
}

/** The quoted original under a reply, in plain text. */
export function quoted(message) {
  const who = senderLabel(message);
  const when = message?.sentAt || message?.receivedAt;
  const on = when ? new Date(when).toLocaleString() : '';
  const body = (message?.bodyText || '').trim();
  return `\n\nOn ${on}, ${who} wrote:\n`
    + body.split('\n').map((l) => `> ${l}`).join('\n');
}

/** Reply subject, without stacking "Re: Re: Re:". */
export function replySubject(subject) {
  const s = (subject ?? '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(subject) {
  const s = (subject ?? '').trim();
  return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
}
