/**
 * Writing an email: new, reply or forward.
 *
 * ── WHAT THE SERVER DECIDES, AND THIS SCREEN DOES NOT SECOND-GUESS ───────
 *  • Addresses go up as the person typed them, comma separated, and the API
 *    parses them. A client-side address parser here would be a second opinion
 *    that disagrees with the server on exactly the awkward cases.
 *  • Sending is POST /api/mail/send, multipart, because it carries the files.
 *    It answers 200 with { id: null, warning } when the message went out but
 *    could not be filed in Sent — that is SUCCESS. Retrying it sends twice.
 *  • Attachments are NOT kept with a draft (the API drops them), so this
 *    screen has no Save draft button rather than one that quietly loses files.
 *    Closing asks before throwing writing away.
 * ─────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  StyleSheet, BackHandler, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';

import {
  send, addressList, quoted, replySubject, forwardSubject, senderLabel,
  suggestRecipients, typingTerm, withRecipient, signatureFor,
} from '../lib/mail';
import { htmlToText } from '../lib/mailHtml';
import { brand, surface, text } from '../theme';

const log = (line) => console.log(`[mail] ${line}`);

// The API refuses anything over 25 MB before encoding. Catching it here saves
// a minute of uploading on a phone connection to earn a refusal.
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * The suggestion list, drawn under whichever address box is being typed in.
 *
 * A colleague is marked, because "Ravi" in your own organisation and "Ravi"
 * at a supplier are different people and the address alone does not say so
 * at a glance on a narrow screen.
 */
function Suggestions({ show, hits, onPick }) {
  if (!show || hits.length === 0) return null;
  return (
    <View style={s.suggest}>
      {hits.map((h) => (
        <Pressable key={`${h.id}-${h.email}`} style={s.suggestRow}
                   onPress={() => onPick(h)}
                   accessibilityLabel={`Use ${h.displayName || h.email}`}>
          <Ionicons name={h.isColleague ? 'business-outline' : 'person-outline'}
                    size={16} color={text.muted} />
          <View style={{ flex: 1 }}>
            <Text style={s.suggestName} numberOfLines={1}>{h.displayName || h.email}</Text>
            {h.displayName && h.displayName !== h.email ? (
              <Text style={s.suggestMail} numberOfLines={1}>{h.email}</Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

export default function MailCompose({ session, draft, signature, onClose, onSent }) {
  const token = session?.accessToken;
  const original = draft?.message ?? null;
  const kind = draft?.kind ?? 'new';

  const start = useMemo(() => {
    // The API's signature is an OBJECT; see signatureFor in lib/mail.js for
    // the email that went out reading "[object Object]".
    const sig = signatureFor(signature, kind);
    if (kind === 'reply' && original) {
      return {
        to: original.from?.email ?? '',
        subject: replySubject(original.subject),
        body: `\n${sig ? `\n${sig}\n` : ''}${quoted(original)}`,
      };
    }
    if (kind === 'forward' && original) {
      return {
        to: '',
        subject: forwardSubject(original.subject),
        body: `\n${sig ? `\n${sig}\n` : ''}\n---------- Forwarded message ----------\n`
          + `From: ${senderLabel(original)}\n`
          + `To: ${addressList(original.to)}\n`
          + `Subject: ${original.subject ?? ''}\n\n`
          + (original.bodyText || htmlToText(original.bodyHtml) || ''),
      };
    }
    return { to: '', subject: '', body: sig ? `\n\n${sig}` : '' };
  }, [kind, original, signature]);

  const [to, setTo] = useState(start.to);
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  // null = nothing in flight or the size is unknown (an indeterminate bar);
  // 0..1 = how much of the body has gone up.
  const [progress, setProgress] = useState(null);

  // ── SUGGESTING RECIPIENTS ───────────────────────────────────────────────
  //  Amit, 18 Sept 2026: "auto name suggestion on to and cc". Typing an
  //  address on a phone keyboard is the slowest part of writing an email.
  //
  //  `field` is which box is being typed in ('to' | 'cc' | null) — the list
  //  belongs under THAT box, and two boxes must never both show one.
  // ────────────────────────────────────────────────────────────────────────
  const [field, setField] = useState(null);
  const [hits, setHits] = useState([]);

  useEffect(() => {
    const term = typingTerm(field === 'to' ? to : field === 'cc' ? cc : '');
    if (!field || !term) { setHits([]); return undefined; }

    // Debounced: a lookup per keystroke is a request per keystroke, on a
    // phone's connection, and the answers arrive out of order.
    let live = true;
    const t = setTimeout(async () => {
      try {
        const rows = await suggestRecipients(token, term);
        // `live` guards the out-of-order case: a slow answer for "am" must not
        // replace a fast one for "amit".
        if (live) setHits(Array.isArray(rows) ? rows : []);
      } catch {
        // A lookup that fails is not an error the person needs to see; they
        // can still type the address. Silence here, not a red banner.
        if (live) setHits([]);
      }
    }, 220);

    return () => { live = false; clearTimeout(t); };
  }, [field, to, cc, token]);

  function pick(row) {
    if (field === 'cc') setCc(withRecipient(cc, row.email));
    else setTo(withRecipient(to, row.email));
    touched.current = true;
    setHits([]);
  }

  const [error, setError] = useState('');
  const touched = useRef(false);

  const dirty = () => touched.current || files.length > 0;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, subject, body, files]);

  function close() {
    if (!dirty()) { onClose(); return; }
    Alert.alert('Discard this email?', 'What you have written will be lost.', [
      { text: 'Keep writing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  }

  async function attach() {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (picked.canceled) return;
      const added = (picked.assets ?? []).map((a) => ({
        uri: a.uri, name: a.name ?? 'attachment', mimeType: a.mimeType, size: a.size ?? 0,
      }));
      const next = [...files, ...added];
      const total = next.reduce((n, f) => n + (f.size ?? 0), 0);
      if (total > MAX_TOTAL_BYTES) {
        setError('Those files come to more than 25 MB, which the mail server will refuse. Send a link instead.');
        return;
      }
      setError('');
      setFiles(next);
      log(`attached ${added.length} file(s), ${Math.round(total / 1024)} KB total`);
    } catch (e) {
      log(`attach failed: ${e?.message ?? e}`);
      setError('Could not attach that file.');
    }
  }

  async function submit() {
    if (!to.trim()) { setError('Say who this is going to.'); return; }
    setSending(true);
    setProgress(files.length ? 0 : null);
    setError('');
    try {
      const out = await send(token, {
        to: to.trim(),
        cc: cc.trim(),
        subject: subject.trim(),
        bodyText: body,
        inReplyToId: kind === 'reply' ? original?.id : undefined,
        files,
      }, (fraction) => setProgress(fraction));
      // Never the addresses or the subject: this log is read over somebody's
      // shoulder as often as not.
      log(`sent (${files.length} attachment(s))${out?.warning ? ' with a warning' : ''}`);
      onSent(out?.warning || null);
    } catch (e) {
      log(`send failed: ${e?.message ?? e}`);
      setError(e?.message || 'Could not send that email.');
      setSending(false);
      setProgress(null);
    }
  }

  const heading = kind === 'reply' ? 'Reply' : kind === 'forward' ? 'Forward' : 'New email';

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.bar}>
        <Pressable onPress={close} hitSlop={10} accessibilityLabel="Close">
          <Ionicons name="close" size={24} color={text.primary} />
        </Pressable>
        <Text style={s.title}>{heading}</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={attach} hitSlop={10} disabled={sending} accessibilityLabel="Attach a file">
          <Ionicons name="attach" size={22} color={text.primary} />
        </Pressable>
        <Pressable onPress={submit} hitSlop={10} disabled={sending} accessibilityLabel="Send this email">
          {sending ? <ActivityIndicator color={brand.base} />
                   : <Ionicons name="send" size={20} color={brand.base} />}
        </Pressable>
      </View>

      {/* ── HOW FAR THE ATTACHMENT HAS GOT. ────────────────────────────────
          Amit, 18 Sept 2026: "give progress bar that attachment that much %
          is uploaded". A spinner on a slow uplink is indistinguishable from
          a hang, and the answer to a hang is to press Send again.

          When the platform will not say how big the body is, progress comes
          back null and the bar fills completely with no number — honest
          about not knowing, rather than inventing a percentage. */}
      {sending && files.length > 0 ? (
        <View style={s.progressRow} accessibilityLabel={
          progress === null ? 'Sending' : `Sending, ${Math.round(progress * 100)} percent`
        }>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${Math.round((progress ?? 1) * 100)}%` }]} />
          </View>
          <Text style={s.progressText}>
            {progress === null ? 'Sending…' : `${Math.round(progress * 100)}%`}
          </Text>
        </View>
      ) : null}

      <KeyboardAvoidingView style={{ flex: 1 }}
                            behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Field label="To">
            <TextInput style={s.input} value={to}
                       onChangeText={(v) => { touched.current = true; setTo(v); }}
                       placeholder="name@example.com, another@example.com"
                       placeholderTextColor={text.muted}
                       autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
                       onFocus={() => setField('to')}
                       editable={!sending} accessibilityLabel="To" />
          </Field>
          <Suggestions show={field === 'to'} hits={hits} onPick={pick} />

          {showCc ? (
            <Field label="Cc">
              <TextInput style={s.input} value={cc}
                         onChangeText={(v) => { touched.current = true; setCc(v); }}
                         autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
                         onFocus={() => setField('cc')}
                         editable={!sending} accessibilityLabel="Cc" />
            </Field>
          ) : null}
          <Suggestions show={field === 'cc'} hits={hits} onPick={pick} />
          {!showCc ? (
            <Pressable onPress={() => setShowCc(true)} accessibilityLabel="Add Cc">
              <Text style={s.addCc}>Add Cc</Text>
            </Pressable>
          ) : null}

          <Field label="Subject">
            <TextInput style={s.input} value={subject}
                       onChangeText={(v) => { touched.current = true; setSubject(v); }}
                       editable={!sending} accessibilityLabel="Subject" />
          </Field>

          {files.length > 0 ? (
            <View style={s.files}>
              {files.map((f, i) => (
                <View key={`${f.uri}-${i}`} style={s.fileRow}>
                  <Ionicons name="document-outline" size={16} color={text.secondary} />
                  <Text style={s.fileName} numberOfLines={1}>{f.name}</Text>
                  <Pressable onPress={() => setFiles(files.filter((_, j) => j !== i))}
                             hitSlop={8} accessibilityLabel={`Remove ${f.name}`}>
                    <Ionicons name="close-circle" size={18} color={text.muted} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          {error ? <Text style={s.error}>{error}</Text> : null}

          <TextInput
            style={s.editor}
            value={body}
            onChangeText={(v) => { touched.current = true; setBody(v); }}
            multiline
            textAlignVertical="top"
            placeholder="Write your message"
            placeholderTextColor={text.muted}
            editable={!sending}
            accessibilityLabel="Message"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, children }) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.page },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 18,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: surface.border,
  },
  progressRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: surface.border,
  },
  progressTrack: {
    flex: 1, height: 6, borderRadius: 3, overflow: 'hidden',
    backgroundColor: surface.border,
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: brand.base },
  // Tabular-width digits would jump about less, but the count is small and
  // the bar carries the meaning; the number is the confirmation.
  suggest: {
    marginTop: -4, marginBottom: 10, borderRadius: 8,
    borderWidth: 1, borderColor: surface.border, backgroundColor: surface.card,
    overflow: 'hidden',
  },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: surface.border,
  },
  suggestName: { fontSize: 14, color: text.primary },
  suggestMail: { fontSize: 12, color: text.muted, marginTop: 1 },
  progressText: { fontSize: 12, color: text.muted, minWidth: 54, textAlign: 'right' },
  title: { fontSize: 17, fontWeight: '700', color: text.primary, marginLeft: 4 },
  body: { padding: 16, paddingBottom: 40 },
  field: { marginBottom: 12 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: text.muted, marginBottom: 4 },
  input: {
    height: 44, borderWidth: 1, borderColor: surface.border, borderRadius: 8,
    backgroundColor: surface.card, paddingHorizontal: 12, fontSize: 15, color: text.primary,
  },
  addCc: { color: brand.base, fontSize: 13, fontWeight: '600', marginBottom: 12 },
  files: { marginBottom: 12, gap: 6 },
  fileRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8,
    borderRadius: 8, backgroundColor: surface.card, borderWidth: 1, borderColor: surface.border,
  },
  fileName: { flex: 1, fontSize: 13, color: text.primary },
  error: { color: '#993556', fontSize: 13, marginBottom: 10 },
  editor: {
    minHeight: 220, borderWidth: 1, borderColor: surface.border, borderRadius: 8,
    backgroundColor: surface.card, padding: 12, fontSize: 15, lineHeight: 21, color: text.primary,
  },
});
