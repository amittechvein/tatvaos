/**
 * One email: who sent it, when, what it says, and what you can do about it.
 *
 * The body is rendered in a WebView with JAVASCRIPT OFF and a content policy
 * that blocks everything except the message's own markup — see lib/mailHtml.js
 * for the whole reasoning. Two things follow that are worth knowing here:
 *
 *  • Remote images are blocked until the person taps Show images. A remote
 *    image is a read receipt for the sender; that is a choice, not a default.
 *  • Links never navigate inside this screen. Every http/https tap opens the
 *    system browser, with its address bar and the person's own session. The
 *    same argument the dashboard makes for not putting our products in a web
 *    view applies doubly to a stranger's link.
 *
 * Marking as read happens HERE, after the message is actually shown, and the
 * list is told to reload on the way out. The API's own flag (isRead) is the
 * truth; this screen does not keep a second copy of it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet,
  BackHandler, Linking, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { getMessage, setRead, setFlag, deleteMessage, attachmentUrl, senderLabel, addressList } from '../lib/mail';
import { buildDocument } from '../lib/mailHtml';
import { brand, surface, text } from '../theme';

const log = (line) => console.log(`[mail] ${line}`);

export default function MailMessage({ session, messageId, onBack, onReply, onChanged }) {
  const token = session?.accessToken;

  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [showImages, setShowImages] = useState(false);
  const [height, setHeight] = useState(320);
  const [saving, setSaving] = useState(null);
  const gone = useRef(false);
  const changed = useRef(false);

  const back = useCallback(() => { onBack(changed.current); }, [onBack]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => sub.remove();
  }, [back]);

  useEffect(() => {
    gone.current = false;
    (async () => {
      try {
        const m = await getMessage(token, messageId);
        if (gone.current) return;
        setMsg(m);
        // Read AFTER it is on the screen, and only if it was not already read:
        // a list that marks on tap marks messages nobody saw.
        if (m?.isRead === false) {
          try {
            await setRead(token, messageId, true);
            changed.current = true;
            log(`marked read ${messageId}`);
          } catch (e) { log(`could not mark read: ${e?.message ?? e}`); }
        }
      } catch (e) {
        if (gone.current) return;
        log(`open failed: ${e?.message ?? e}`);
        setError(e?.message || 'Could not open that message.');
      } finally {
        if (!gone.current) setBusy(false);
      }
    })();
    return () => { gone.current = true; };
  }, [messageId, token]);

  async function toggleFlag() {
    if (!msg) return;
    const next = !msg.isFlagged;
    setMsg({ ...msg, isFlagged: next });
    try {
      await setFlag(token, msg.id, next);
      changed.current = true;
    } catch (e) {
      setMsg({ ...msg, isFlagged: !next });
      setError(e?.message || 'Could not change that.');
    }
  }

  async function unread() {
    if (!msg) return;
    try {
      await setRead(token, msg.id, false);
      changed.current = true;
      onChanged?.();
      back();
    } catch (e) { setError(e?.message || 'Could not mark it unread.'); }
  }

  function confirmDelete() {
    Alert.alert(
      'Delete this message?',
      'It moves to Trash. Deleting it from Trash removes it for good.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const out = await deleteMessage(token, msg.id);
              changed.current = true;
              log(out?.deleted ? 'deleted for good' : 'moved to Trash');
              back();
            } catch (e) { setError(e?.message || 'Could not delete it.'); }
          },
        },
      ],
    );
  }

  /**
   * Download an attachment and hand it to the phone's share sheet, which is
   * how a file gets out of an app's private storage on Android. The request
   * carries the bearer token — the download URL is not public, and opening it
   * in a browser would only produce a sign-in page.
   */
  async function openAttachment(a) {
    if (a.scanStatus === 'infected') {
      Alert.alert('Blocked', 'This attachment failed a virus scan and cannot be opened.');
      return;
    }
    setSaving(a.id);
    try {
      const safe = (a.filename || 'attachment').replace(/[^\w.\- ]+/g, '_');
      const target = `${FileSystem.cacheDirectory}${Date.now()}-${safe}`;
      const res = await FileSystem.downloadAsync(attachmentUrl(msg.id, a.id), target, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) throw new Error(`The server answered ${res.status}.`);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri);
      else Alert.alert('Saved', `Saved as ${safe}.`);
      log(`attachment ${a.id} saved (${a.sizeBytes ?? '?'} bytes)`);
    } catch (e) {
      log(`attachment failed: ${e?.message ?? e}`);
      Alert.alert('Could not open that file', e?.message ?? 'The download failed.');
    } finally {
      setSaving(null);
    }
  }

  if (busy) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centre}><ActivityIndicator color={brand.base} /></View>
      </SafeAreaView>
    );
  }

  if (!msg) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.bar}>
          <Pressable onPress={back} hitSlop={10} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={26} color={text.primary} />
          </Pressable>
        </View>
        <View style={s.centre}><Text style={s.error}>{error || 'That message is not here.'}</Text></View>
      </SafeAreaView>
    );
  }

  const { document, blocked } = buildDocument({
    html: msg.bodyHtml, text: msg.bodyText, showImages,
  });

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.bar}>
        <Pressable onPress={back} hitSlop={10} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={26} color={text.primary} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={toggleFlag} hitSlop={10}
                   accessibilityLabel={msg.isFlagged ? 'Remove star' : 'Star this message'}>
          <Ionicons name={msg.isFlagged ? 'star' : 'star-outline'} size={22}
                    color={msg.isFlagged ? '#E0A100' : text.primary} />
        </Pressable>
        <Pressable onPress={unread} hitSlop={10} accessibilityLabel="Mark unread">
          <Ionicons name="mail-unread-outline" size={22} color={text.primary} />
        </Pressable>
        <Pressable onPress={confirmDelete} hitSlop={10} accessibilityLabel="Delete this message">
          <Ionicons name="trash-outline" size={22} color="#B3261E" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.subject}>{msg.subject || '(no subject)'}</Text>
        <Text style={s.from}>{senderLabel(msg)}</Text>
        <Text style={s.meta} numberOfLines={2}>
          to {addressList(msg.to) || 'you'}
          {msg.cc?.length ? ` · cc ${addressList(msg.cc)}` : ''}
        </Text>
        <Text style={s.meta}>
          {new Date(msg.receivedAt || msg.sentAt).toLocaleString()}
        </Text>

        {error ? <Text style={s.error}>{error}</Text> : null}

        {blocked > 0 ? (
          <Pressable style={s.banner} onPress={() => setShowImages(true)}
                     accessibilityLabel="Show images in this message">
            <Ionicons name="image-outline" size={16} color={text.secondary} />
            <Text style={s.bannerText}>
              {blocked} image{blocked === 1 ? '' : 's'} blocked. Showing them tells the sender you opened this.
            </Text>
            <Text style={s.bannerAction}>Show</Text>
          </Pressable>
        ) : null}

        <View style={[s.webWrap, { height }]}>
          <WebView
            originWhitelist={['*']}
            source={{ html: document }}
            // The whole safety model in three props: no JavaScript, no new
            // windows, and every navigation intercepted below.
            javaScriptEnabled={false}
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(req) => {
              if (req.url === 'about:blank' || req.url.startsWith('data:')) return true;
              if (/^https?:/i.test(req.url)) { Linking.openURL(req.url).catch(() => {}); return false; }
              if (/^mailto:/i.test(req.url)) { Linking.openURL(req.url).catch(() => {}); return false; }
              return false;
            }}
            // The document reports its own height once, so the message scrolls
            // with the rest of the screen instead of inside a box.
            injectedJavaScriptBeforeContentLoaded=""
            onMessage={() => {}}
            scrollEnabled={false}
            onLoadEnd={() => setHeight((h) => Math.max(h, 320))}
            style={{ backgroundColor: 'transparent' }}
          />
        </View>

        {msg.attachments?.length ? (
          <View style={s.attach}>
            <Text style={s.attachTitle}>
              {msg.attachments.length} attachment{msg.attachments.length === 1 ? '' : 's'}
            </Text>
            {msg.attachments.map((a) => (
              <Pressable key={a.id} style={s.attachRow} onPress={() => openAttachment(a)}
                         accessibilityLabel={`Open ${a.filename}`}>
                <Ionicons name="document-outline" size={18} color={text.secondary} />
                <Text style={s.attachName} numberOfLines={1}>{a.filename}</Text>
                <Text style={s.attachSize}>{sizeLabel(a.sizeBytes)}</Text>
                {saving === a.id ? <ActivityIndicator color={brand.base} /> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={s.actions}>
        <Action icon="arrow-undo-outline" label="Reply"
                onPress={() => onReply({ kind: 'reply', message: msg })} />
        <Action icon="arrow-redo-outline" label="Forward"
                onPress={() => onReply({ kind: 'forward', message: msg })} />
      </View>
    </SafeAreaView>
  );
}

function Action({ icon, label, onPress }) {
  return (
    <Pressable style={s.action} onPress={onPress} accessibilityLabel={label}>
      <Ionicons name={icon} size={20} color={brand.base} />
      <Text style={s.actionText}>{label}</Text>
    </Pressable>
  );
}

function sizeLabel(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.page },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 18,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: surface.border,
  },
  body: { padding: 16, paddingBottom: 28 },
  subject: { fontSize: 20, fontWeight: '700', color: text.primary, marginBottom: 8 },
  from: { fontSize: 15, fontWeight: '600', color: text.primary },
  meta: { fontSize: 12, color: text.muted, marginTop: 2 },
  error: { color: '#993556', fontSize: 13, marginTop: 8 },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12,
    padding: 10, borderRadius: 8, backgroundColor: surface.card,
    borderWidth: 1, borderColor: surface.border,
  },
  bannerText: { flex: 1, fontSize: 12, color: text.secondary },
  bannerAction: { fontSize: 13, fontWeight: '700', color: brand.base },
  webWrap: { marginTop: 12, borderRadius: 8, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  attach: { marginTop: 16 },
  attachTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 1, color: text.muted, marginBottom: 6 },
  attachRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: surface.border,
  },
  attachName: { flex: 1, fontSize: 14, color: text.primary },
  attachSize: { fontSize: 12, color: text.muted },
  actions: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: surface.border,
    backgroundColor: surface.card,
  },
  action: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 12 },
  actionText: { fontSize: 12, color: brand.base, fontWeight: '600' },
});
