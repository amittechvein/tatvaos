/**
 * Mail, natively: the folder you are in, and what is in it.
 *
 * Amit asked for native Mail screens twice (16 and 17 Sept 2026). That
 * SUPERSEDES docs/MOBILE_LANE_BRIEF.md §3–4, which says every product except
 * Login, Dashboard and Connect is a web view — see
 * docs/decisions/0006-native-mail-on-the-phone.md for the reasoning and what
 * it costs. Connect proved the pattern: a native screen against the same API
 * the web app uses, no handoff, no browser.
 *
 * ── WHAT THIS SCREEN REFUSES TO GUESS ────────────────────────────────────
 *  • NO MAILBOX IS NOT AN ERROR. /bootstrap answers { mailbox: null } for a
 *    person without Mail; the API never 403s. That is an empty state.
 *  • `isRead`, not `unread`. The API says isRead and this file keeps the
 *    name — inverting it silently in a client is how a dot ends up on every
 *    read message.
 *  • Paging is skip/take, and the server clamps take to 100. "Load more"
 *    asks for the next page rather than growing one request.
 * ─────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, TextInput, ActivityIndicator,
  RefreshControl, StyleSheet, BackHandler, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import {
  bootstrap, listMessages, searchMessages, orderFolders, senderLabel, whenLabel,
} from '../lib/mail';
import { brand, surface, text } from '../theme';

const log = (line) => console.log(`[mail] ${line}`);
const PAGE = 30;

export default function Mail({ session, onBack, onOpen, onCompose, onMailbox, notice, onNoticeSeen, reloadKey = 0 }) {
  const token = session?.accessToken;

  const [mailbox, setMailbox] = useState(undefined); // undefined = still asking
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [pickFolder, setPickFolder] = useState(false);
  const gone = useRef(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  // Mailbox and folders once per mount; the message list follows the folder.
  useEffect(() => {
    gone.current = false;
    (async () => {
      try {
        const b = await bootstrap(token);
        if (gone.current) return;
        setMailbox(b.mailbox);
        const ordered = orderFolders(b.folders);
        setFolders(ordered);
        setFolder((f) => f ?? ordered.find((x) => x.slug === 'inbox') ?? ordered[0] ?? null);
        // The signature belongs to the mailbox, not the profile, and only
        // /bootstrap knows it. Compose is opened from App.js, so it goes up.
        onMailbox?.({ mailbox: b.mailbox, signature: b.signature });
        log(`mailbox ${b.mailbox ? 'ready' : 'none'}, ${ordered.length} folder(s)`);
      } catch (e) {
        if (gone.current) return;
        log(`bootstrap failed: ${e?.message ?? e}`);
        setError(e?.message || 'Could not open your mail.');
        setMailbox(null);
      } finally {
        if (!gone.current) setBusy(false);
      }
    })();
    return () => { gone.current = true; };
  }, [token]);

  const load = useCallback(async (opts = {}) => {
    const { append = false, q = null } = opts;
    if (!folder && !q) return;
    setError('');
    if (append) setMore(true); else setBusy(true);
    try {
      const skip = append ? rows.length : 0;
      const page = q
        ? await searchMessages(token, q, { skip, take: PAGE })
        : await listMessages(token, folder.id, { skip, take: PAGE });
      if (gone.current) return;
      setRows(append ? [...rows, ...page.messages] : page.messages);
      setTotal(page.total);
    } catch (e) {
      if (gone.current) return;
      log(`list failed: ${e?.message ?? e}`);
      setError(e?.message || 'Could not load these messages.');
    } finally {
      if (!gone.current) { setBusy(false); setMore(false); }
    }
  }, [folder, rows, token]);

  // The folder changes, or the screen is asked to reload (a message was read,
  // deleted or sent). Not `load` in the deps: it changes with every row list.
  useEffect(() => {
    if (!folder) return;
    setSearching(false);
    setQuery('');
    load({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.id, reloadKey]);

  async function runSearch() {
    const q = query.trim();
    if (!q) { setSearching(false); load({}); return; }
    setSearching(true);
    setRows([]);
    await load({ q });
  }

  if (busy && mailbox === undefined) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centre}><ActivityIndicator color={brand.base} /></View>
      </SafeAreaView>
    );
  }

  // A person without Mail is not refused by the API; they simply have no
  // mailbox. Saying that plainly beats an error they cannot act on.
  if (mailbox === null) {
    return (
      <SafeAreaView style={s.screen}>
        <Header title="Mail" onBack={onBack} />
        <View style={s.centre}>
          <Ionicons name="mail-outline" size={40} color={text.muted} />
          <Text style={s.emptyTitle}>No mailbox on this account</Text>
          <Text style={s.emptyBody}>
            {error || 'Ask your administrator to add Mail, and it will appear here.'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen}>
      <Header
        title={folder?.name || 'Mail'}
        subtitle={mailbox?.address}
        onBack={onBack}
        right={(
          <Pressable onPress={() => setPickFolder(true)} hitSlop={8}
                     accessibilityLabel="Choose folder">
            <Ionicons name="folder-open-outline" size={22} color={text.primary} />
          </Pressable>
        )}
      />

      <View style={s.searchRow}>
        <Ionicons name="search" size={16} color={text.muted} />
        <TextInput
          style={s.search}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={runSearch}
          returnKeyType="search"
          placeholder="Search mail"
          placeholderTextColor={text.muted}
          autoCapitalize="none"
          accessibilityLabel="Search mail"
        />
        {searching || query.length > 0 ? (
          <Pressable onPress={() => { setQuery(''); setSearching(false); load({}); }} hitSlop={8}
                     accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={18} color={text.muted} />
          </Pressable>
        ) : null}
      </View>

      {notice ? (
        <Pressable style={s.notice} onPress={onNoticeSeen} accessibilityLabel="Dismiss">
          <Ionicons name="checkmark-circle" size={16} color={brand.base} />
          <Text style={s.noticeText}>{notice}</Text>
        </Pressable>
      ) : null}

      {error ? <Text style={s.error}>{error}</Text> : null}

      <FlatList
        data={rows}
        keyExtractor={(m) => m.id}
        refreshControl={<RefreshControl refreshing={busy && rows.length > 0}
                                        onRefresh={() => load({ q: searching ? query : null })}
                                        tintColor={brand.base} />}
        ListEmptyComponent={!busy ? (
          <View style={s.centre}>
            <Text style={s.emptyBody}>
              {searching ? 'Nothing matched that search.' : 'Nothing here yet.'}
            </Text>
          </View>
        ) : null}
        renderItem={({ item }) => <Row m={item} onPress={() => onOpen(item)} />}
        ListFooterComponent={rows.length < total ? (
          <Pressable style={s.moreBtn} onPress={() => load({ append: true, q: searching ? query : null })}
                     disabled={more} accessibilityLabel="Load more messages">
            {more ? <ActivityIndicator color={brand.base} />
                  : <Text style={s.moreText}>Load more ({rows.length} of {total})</Text>}
          </Pressable>
        ) : null}
      />

      <Pressable style={s.fab} onPress={() => onCompose({ kind: 'new' })}
                 accessibilityLabel="Write a new email">
        <Ionicons name="create-outline" size={22} color={brand.onBase} />
      </Pressable>

      <Modal visible={pickFolder} transparent animationType="fade"
             onRequestClose={() => setPickFolder(false)}>
        <Pressable style={s.backdrop} onPress={() => setPickFolder(false)}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Folders</Text>
            {folders.map((f) => (
              <Pressable key={f.id} style={s.folderRow}
                         onPress={() => { setPickFolder(false); setFolder(f); }}
                         accessibilityLabel={`Open ${f.name}`}>
                <Text style={[s.folderName, f.id === folder?.id && s.folderOn]} numberOfLines={1}>
                  {f.name}
                </Text>
                {f.unreadCount > 0 ? <Text style={s.folderCount}>{f.unreadCount}</Text> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function Header({ title, subtitle, onBack, right }) {
  return (
    <View style={s.header}>
      <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back">
        <Ionicons name="chevron-back" size={26} color={text.primary} />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={s.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

function Row({ m, onPress }) {
  const unread = m.isRead === false;
  return (
    <Pressable style={s.row} onPress={onPress}
               accessibilityLabel={`${unread ? 'Unread. ' : ''}${senderLabel(m)}. ${m.subject || 'No subject'}`}>
      <View style={s.dotCol}>
        {unread ? <View style={s.dot} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={s.rowTop}>
          <Text style={[s.from, unread && s.strong]} numberOfLines={1}>{senderLabel(m)}</Text>
          <Text style={s.when}>{whenLabel(m.receivedAt || m.sentAt)}</Text>
        </View>
        <Text style={[s.subject, unread && s.strong]} numberOfLines={1}>
          {m.subject || '(no subject)'}
        </Text>
        <View style={s.rowBottom}>
          <Text style={s.snippet} numberOfLines={1}>{m.snippet || ''}</Text>
          {m.hasAttachments ? <Ionicons name="attach" size={14} color={text.muted} /> : null}
          {m.isFlagged ? <Ionicons name="star" size={14} color="#E0A100" /> : null}
        </View>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.page },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
  },
  title: { fontSize: 20, fontWeight: '700', color: text.primary },
  subtitle: { fontSize: 12, color: text.muted, marginTop: 1 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 12, height: 40,
    borderRadius: 10, backgroundColor: surface.card, borderWidth: 1, borderColor: surface.border,
  },
  search: { flex: 1, fontSize: 15, color: text.primary, padding: 0 },
  row: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: surface.border,
  },
  dotCol: { width: 10, paddingTop: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: brand.base },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  from: { flex: 1, fontSize: 15, color: text.primary },
  when: { fontSize: 12, color: text.muted },
  subject: { fontSize: 14, color: text.primary, marginTop: 1 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  snippet: { flex: 1, fontSize: 13, color: text.secondary },
  strong: { fontWeight: '700' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: text.primary },
  emptyBody: { fontSize: 14, color: text.secondary, textAlign: 'center', lineHeight: 20 },
  error: { color: '#993556', paddingHorizontal: 16, paddingBottom: 8, fontSize: 13 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 8,
    backgroundColor: surface.card, borderWidth: 1, borderColor: surface.border,
  },
  noticeText: { flex: 1, fontSize: 13, color: text.secondary },
  moreBtn: { padding: 16, alignItems: 'center' },
  moreText: { color: brand.base, fontSize: 14, fontWeight: '600' },
  fab: {
    position: 'absolute', right: 20, bottom: 28, width: 56, height: 56, borderRadius: 28,
    backgroundColor: brand.base, alignItems: 'center', justifyContent: 'center', elevation: 4,
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: surface.card, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28,
  },
  sheetTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 1, color: text.muted, marginBottom: 6 },
  folderRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: surface.border,
  },
  folderName: { flex: 1, fontSize: 16, color: text.primary },
  folderOn: { color: brand.base, fontWeight: '700' },
  folderCount: { fontSize: 13, color: text.muted },
});
