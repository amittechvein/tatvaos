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
  View, Text, FlatList, Pressable, TextInput, ActivityIndicator, RefreshControl, StyleSheet, BackHandler, Modal, Switch, ScrollView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import {
  bootstrap, listMessages, searchMessages, orderFolders, senderLabel, whenLabel, SORTS, DEFAULT_SORT, sortLabel, listMailboxes,
} from '../lib/mail';
import { SEARCH_OPERATORS, buildSearchQuery, mentionsBin, chipsFor, hasOperators, formFromQuery } from '../lib/mailSearch';
import { brand, surface, text, radius, space, type, shadow, tone } from '../theme';

const log = (line) => console.log(`[mail] ${line}`);
const PAGE = 30;

export default function Mail({
  session, onBack, onOpen, onCompose, onMailbox, notice, onNoticeSeen, reloadKey = 0,
  mailboxId = null, onSwitchMailbox,
}) {
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
  // ── SEARCH THE WAY THE WEB SEARCHES, 24 SEPT 2026. ─────────────────────
  //  The grammar is the server's (PR 232) and the typed string goes through
  //  unchanged, so what the phone adds is what the web puts around the box:
  //  the operator list, a form that writes the query, chips, and the note
  //  that deleted and junk mail stay out unless asked. lib/mailSearch.js.
  // ─────────────────────────────────────────────────────────────────────
  const [showHelp, setShowHelp] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adv, setAdv] = useState({ from: '', to: '', subject: '', words: '', without: '', where: '', within: '', sizeOp: 'larger', sizeVal: '', sizeUnit: 'M', hasAttachment: false, unreadOnly: false });
  const setA = (k, v) => setAdv((a) => ({ ...a, [k]: v }));
  const advQuery = buildSearchQuery(adv);
  // ── SHARED MAILBOXES. ──────────────────────────────────────────────────
  //  Amit, 23 Sept 2026. `mailboxes` is every mailbox this person may open,
  //  own first; the picker only exists when there is more than one, so a
  //  person with only their own mailbox never sees a control that does
  //  nothing. `current` is the row for `mailboxId`, which App.js owns.
  // ─────────────────────────────────────────────────────────────────────
  const [mailboxes, setMailboxes] = useState([]);
  const [pickMailbox, setPickMailbox] = useState(false);
  const current = mailboxes.find((m) => (mailboxId ? m.id === mailboxId : m.isOwn)) ?? null;
  const readOnly = !!mailboxId && current ? !current.canSend : false;
  // The order of the folder list. Amit on his own phone, 19 Sept 2026:
  // "sorting option on mail". Kept across folders - somebody who wants unread
  // first wants it in every folder - and not kept across launches, so the app
  // always opens the way every mail app does.
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [pickSort, setPickSort] = useState(false);
  const [sortNotice, setSortNotice] = useState('');
  const insets = useSafeAreaInsets();
  const gone = useRef(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);

  // Mailbox and folders once per mount; the message list follows the folder.
  useEffect(() => {
    gone.current = false;
    // Once per token, not per mailbox: the grants do not change by switching.
    listMailboxes(token)
      .then((rows) => { if (!gone.current) setMailboxes(rows); })
      .catch((e) => log(`mailboxes list failed: ${e?.message ?? e}`));
    return () => { gone.current = true; };
  }, [token]);

  useEffect(() => {
    gone.current = false;
    setFolder(null);
    setBusy(true);
    (async () => {
      try {
        const b = await bootstrap(token, mailboxId);
        if (gone.current) return;
        setMailbox(b.mailbox);
        const ordered = orderFolders(b.folders);
        setFolders(ordered);
        setFolder((f) => f ?? ordered.find((x) => x.slug === 'inbox') ?? ordered[0] ?? null);
        // The signature belongs to the mailbox, not the profile, and only
        // /bootstrap knows it. Compose is opened from App.js, so it goes up.
        onMailbox?.({ mailbox: b.mailbox, signature: b.signature });
        log(`mailbox ${b.mailbox ? 'ready' : 'none'}${mailboxId ? ' (shared)' : ''}, ${ordered.length} folder(s)`);
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
  }, [token, mailboxId]);

  const load = useCallback(async (opts = {}) => {
    const { append = false, q = null } = opts;
    if (!folder && !q) return;
    setError('');
    if (append) setMore(true); else setBusy(true);
    try {
      const skip = append ? rows.length : 0;
      const page = q
        ? await searchMessages(token, q, { skip, take: PAGE, mailboxId })
        : await listMessages(token, folder.id, { skip, take: PAGE, sort, mailboxId });
      if (gone.current) return;
      // A 200 IS NOT PROOF IT SORTED. A server older than the `sort` parameter
      // ignores it and answers newest first with no `sort` in the reply. Said,
      // and the control put back to what the list really is - never a header
      // reading "Oldest first" over a list that is not.
      if (!q && sort !== DEFAULT_SORT && page.sorted !== sort) {
        log(`asked for ${sort}, server answered ${page.sorted ?? 'no sort field'}: showing newest first`);
        setSortNotice('Sorting is not available on this server yet. Showing newest first.');
        setSort(DEFAULT_SORT);
      }
      // NOT cleared here. Putting the control back reloads the list in the
      // default order, and clearing on that reload wiped this sentence the
      // moment it appeared. It goes when the person next chooses an order.
      setRows(append ? [...rows, ...page.messages] : page.messages);
      setTotal(page.total);
    } catch (e) {
      if (gone.current) return;
      log(`list failed: ${e?.message ?? e}`);
      setError(e?.message || 'Could not load these messages.');
    } finally {
      if (!gone.current) { setBusy(false); setMore(false); }
    }
  }, [folder, rows, token, sort]);

  // The folder changes, or the screen is asked to reload (a message was read,
  // deleted or sent). Not `load` in the deps: it changes with every row list.
  useEffect(() => {
    if (!folder) return;
    setSearching(false);
    setQuery('');
    load({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.id, reloadKey, sort]);

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
          <View style={s.headerActions}>
            {mailboxes.length > 1 ? (
              <Pressable onPress={() => setPickMailbox(true)} hitSlop={8}
                         accessibilityLabel="Choose mailbox"
                         accessibilityValue={{ text: current?.label ?? 'My mailbox' }}>
                <Ionicons name={mailboxId ? 'people' : 'people-outline'} size={22}
                          color={mailboxId ? brand.base : text.primary} />
              </Pressable>
            ) : null}
            <Pressable onPress={() => setPickSort(true)} hitSlop={8}
                       accessibilityLabel="Sort messages" accessibilityValue={{ text: sortLabel(sort) }}>
              <Ionicons name="swap-vertical" size={22}
                        color={sort === DEFAULT_SORT ? text.primary : brand.base} />
            </Pressable>
            <Pressable onPress={() => setPickFolder(true)} hitSlop={8}
                       accessibilityLabel="Choose folder">
              <Ionicons name="folder-open-outline" size={22} color={text.primary} />
            </Pressable>
          </View>
        )}
      />

      {mailboxId && current ? (
        <View style={s.shared} accessibilityRole="text"
              accessibilityLabel={`Reading ${current.address}. ${readOnly ? 'Read only.' : 'Replies go out as this mailbox.'}`}>
          <Ionicons name="people" size={15} color="#7A5100" />
          <Text style={s.sharedText} numberOfLines={2}>
            You are reading <Text style={s.sharedStrong}>{current.address}</Text>
            {readOnly ? ' — read only' : ' — replies go out as this mailbox'}
          </Text>
        </View>
      ) : null}

      <View style={s.searchRow}>
        <Pressable hitSlop={8} onPress={() => setShowHelp(true)} accessibilityLabel="Search help">
          <Ionicons name="search" size={16} color={text.muted} />
        </Pressable>
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
        <Pressable hitSlop={8} onPress={() => { setAdv(formFromQuery(query)); setShowAdvanced(true); }}
                   accessibilityLabel="Advanced search">
          <Ionicons name="options-outline" size={18} color={showAdvanced ? brand.base : text.muted} />
        </Pressable>
        {searching || query.length > 0 ? (
          <Pressable onPress={() => { setQuery(''); setSearching(false); load({}); }} hitSlop={8}
                     accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={18} color={text.muted} />
          </Pressable>
        ) : null}
      </View>

      {!searching && sort !== DEFAULT_SORT ? (
        <Pressable style={s.sortLine} onPress={() => setSort(DEFAULT_SORT)}
                   accessibilityRole="button" accessibilityLabel={`Sorted by ${sortLabel(sort)}. Tap for newest first`}>
          <Ionicons name="swap-vertical" size={14} color={brand.base} />
          <Text style={s.sortLineText}>{sortLabel(sort)}</Text>
          <Ionicons name="close" size={14} color={brand.base} />
        </Pressable>
      ) : null}
      {sortNotice ? <Text style={s.sortNoticeText}>{sortNotice}</Text> : null}

      {searching && hasOperators(query) ? (
        <View style={s.chips} accessibilityLabel="Search terms">
          {chipsFor(query).map((c, i) => (
            <View key={`${c.field}-${c.value}-${i}`} style={[s.chip, c.negated && s.chipNeg]}>
              <Text style={s.chipText} numberOfLines={1}>
                {c.negated ? 'not ' : ''}{c.field ? `${c.field} ` : ''}{c.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {searching && !mentionsBin(query) ? (
        <Text style={s.binNote}>Deleted and junk mail stay out unless you add in:trash, in:spam or in:anywhere.</Text>
      ) : null}
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

      {/* Lifted by the navigation bar's height. `bottom` on an absolute child is
          measured from the parent's EDGE, not from inside its safe-area padding,
          so at a fixed 28 the button sat half under Android's three buttons -
          seen on Amit's Samsung, 19 Sept 2026. */}
      {/* A read-only delegate gets no compose button: the server would
          refuse the send with "no mailbox to send from", after they had
          written the whole email. */}
      {readOnly ? null : (
        <Pressable style={[s.fab, { bottom: 28 + insets.bottom }]} onPress={() => onCompose({ kind: 'new' })}
                   accessibilityLabel="Write a new email">
          <Ionicons name="create-outline" size={22} color={brand.onBase} />
        </Pressable>
      )}

      <Modal visible={pickSort} transparent animationType="fade"
             onRequestClose={() => setPickSort(false)}>
        <Pressable style={s.backdrop} onPress={() => setPickSort(false)}>
          <View style={[s.sheet, { paddingBottom: 16 + insets.bottom }]}>
            <Text style={s.sheetTitle}>SORT BY</Text>
            {SORTS.map(([key, label]) => (
              <Pressable key={key} style={s.folderRow}
                         onPress={() => { setPickSort(false); setSortNotice(''); setSort(key); }}
                         accessibilityRole="button" accessibilityState={{ selected: key === sort }}
                         accessibilityLabel={`Sort by ${label}`}>
                <Text style={[s.folderName, key === sort && s.folderOn]}>{label}</Text>
                {key === sort ? <Ionicons name="checkmark" size={18} color={brand.base} /> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <Modal visible={pickMailbox} transparent animationType="fade"
             onRequestClose={() => setPickMailbox(false)}>
        <Pressable style={s.backdrop} onPress={() => setPickMailbox(false)}>
          <View style={[s.sheet, { paddingBottom: 16 + insets.bottom }]}>
            <Text style={s.sheetTitle}>MAILBOX</Text>
            {mailboxes.map((m) => {
              const on = mailboxId ? m.id === mailboxId : m.isOwn;
              return (
                <Pressable key={m.id} style={s.folderRow}
                           onPress={() => { setPickMailbox(false); onSwitchMailbox?.(m.isOwn ? null : m.id); }}
                           accessibilityLabel={`Open ${m.label}`}
                           accessibilityState={{ selected: on }}>
                  <Ionicons name={m.isOwn ? 'person-outline' : 'people-outline'} size={18}
                            color={on ? brand.base : text.muted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[s.folderName, on && s.folderOn]} numberOfLines={1}>{m.label}</Text>
                    <Text style={s.mailboxMeta} numberOfLines={1}>
                      {m.address}{m.isOwn ? '' : ` · ${m.canSend ? 'can send' : 'read only'}`}
                    </Text>
                  </View>
                  {on ? <Ionicons name="checkmark" size={18} color={brand.base} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>

      <Modal visible={showHelp} transparent animationType="fade" onRequestClose={() => setShowHelp(false)}>
        <Pressable style={s.backdrop} onPress={() => setShowHelp(false)}>
          <View style={[s.sheet, { paddingBottom: 16 + insets.bottom, maxHeight: '80%' }]}>
            <Text style={s.sheetTitle}>SEARCH</Text>
            <Text style={s.helpLead}>
              Combine these freely. A space means <Text style={s.helpStrong}>and</Text>,{' '}
              <Text style={s.helpStrong}>OR</Text> means either, and a <Text style={s.helpStrong}>-</Text> in front leaves something out.
            </Text>
            <ScrollView style={{ flexGrow: 0 }}>
              {SEARCH_OPERATORS.map((o) => (
                <Pressable key={o.op} style={s.helpRow}
                           onPress={() => { setQuery((q) => `${q.trim()} ${o.example}`.trim()); setShowHelp(false); }}
                           accessibilityLabel={`Add ${o.example}`}>
                  <Text style={s.helpExample}>{o.example}</Text>
                  <Text style={s.helpHint}>{o.hint}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={s.helpFoot}>
              Deleted and junk mail stay out unless you ask for them with <Text style={s.helpStrong}>in:trash</Text>,{' '}
              <Text style={s.helpStrong}>in:spam</Text> or <Text style={s.helpStrong}>in:anywhere</Text>.
            </Text>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={showAdvanced} transparent animationType="fade" onRequestClose={() => setShowAdvanced(false)}>
        <Pressable style={s.backdrop} onPress={() => setShowAdvanced(false)}>
          <Pressable style={[s.sheet, { paddingBottom: 16 + insets.bottom, maxHeight: '88%' }]} onPress={() => {}}>
            <Text style={s.sheetTitle}>ADVANCED SEARCH</Text>
            <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
              {[['from', 'From'], ['to', 'To'], ['subject', 'Subject'], ['words', 'Has the words'], ['without', "Doesn't have"]].map(([k, label]) => (
                <View key={k} style={s.advField}>
                  <Text style={s.advLabel}>{label}</Text>
                  <TextInput style={s.advInput} value={adv[k]} onChangeText={(v) => setA(k, v)}
                             autoCapitalize="none" autoCorrect={false} accessibilityLabel={label} />
                </View>
              ))}
              <Text style={s.advLabel}>Search in</Text>
              <View style={s.advChips}>
                {[['', 'All mail'], ['inbox', 'Inbox'], ['sent', 'Sent'], ['drafts', 'Drafts'], ['trash', 'Trash'], ['spam', 'Spam'], ['anywhere', 'Anywhere']].map(([v, label]) => (
                  <Pressable key={v || 'all'} style={[s.advChip, adv.where === v && s.advChipOn]} onPress={() => setA('where', v)}
                             accessibilityRole="radio" accessibilityState={{ selected: adv.where === v }} accessibilityLabel={`Search in: ${label}`}>
                    <Text style={[s.advChipText, adv.where === v && s.advChipTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={s.advLabel}>Date within</Text>
              <View style={s.advChips}>
                {[['', 'Any time'], ['1d', '1 day'], ['7d', '1 week'], ['1m', '1 month'], ['1y', '1 year']].map(([v, label]) => (
                  <Pressable key={v || 'any'} style={[s.advChip, adv.within === v && s.advChipOn]} onPress={() => setA('within', v)}
                             accessibilityRole="radio" accessibilityState={{ selected: adv.within === v }} accessibilityLabel={`Date within: ${label}`}>
                    <Text style={[s.advChipText, adv.within === v && s.advChipTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={s.advLabel}>Size</Text>
              <View style={[s.advChips, { alignItems: 'center' }]}>
                {[['larger', 'Larger than'], ['smaller', 'Smaller than']].map(([v, label]) => (
                  <Pressable key={v} style={[s.advChip, adv.sizeOp === v && s.advChipOn]} onPress={() => setA('sizeOp', v)}
                             accessibilityRole="radio" accessibilityState={{ selected: adv.sizeOp === v }} accessibilityLabel={label}>
                    <Text style={[s.advChipText, adv.sizeOp === v && s.advChipTextOn]}>{label}</Text>
                  </Pressable>
                ))}
                <TextInput style={[s.advInput, { width: 64 }]} value={adv.sizeVal} onChangeText={(v) => setA('sizeVal', v.replace(/[^0-9]/g, ''))}
                           keyboardType="number-pad" placeholder="10" placeholderTextColor={text.muted} accessibilityLabel="Size number" />
                {[['K', 'KB'], ['M', 'MB']].map(([v, label]) => (
                  <Pressable key={v} style={[s.advChip, adv.sizeUnit === v && s.advChipOn]} onPress={() => setA('sizeUnit', v)}
                             accessibilityRole="radio" accessibilityState={{ selected: adv.sizeUnit === v }} accessibilityLabel={`Size unit ${label}`}>
                    <Text style={[s.advChipText, adv.sizeUnit === v && s.advChipTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={s.advSwitch}>
                <Text style={s.advLabel}>Has attachment</Text>
                <Switch value={adv.hasAttachment} onValueChange={(v) => setA('hasAttachment', v)} accessibilityLabel="Has attachment" />
              </View>
              <View style={s.advSwitch}>
                <Text style={s.advLabel}>Unread only</Text>
                <Switch value={adv.unreadOnly} onValueChange={(v) => setA('unreadOnly', v)} accessibilityLabel="Unread only" />
              </View>
              {/* The query it will run, shown before it runs — the web does this
                  so the form teaches the operators instead of hiding them. */}
              <Text style={s.advPreview} accessibilityLabel={`Query: ${advQuery || 'nothing yet'}`}>{advQuery || 'Fill in something above.'}</Text>
            </ScrollView>
            <Pressable style={[s.advGo, !advQuery && { opacity: 0.45 }]} disabled={!advQuery}
                       onPress={() => { setShowAdvanced(false); setQuery(advQuery); load({ q: advQuery }); }}
                       accessibilityLabel="Run this search">
              <Ionicons name="search" size={16} color={brand.onBase} />
              <Text style={s.advGoText}>Search</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

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
      {/* An initial in a circle, not a bare dot: the eye finds a sender by
          the coloured letter long before it reads the name. Unread keeps the
          dot, small, on the circle's shoulder. */}
      <View style={[s.avatar, unread && s.avatarUnread]}>
        <Text style={[s.avatarText, unread && s.avatarTextUnread]}>
          {(senderLabel(m) || '?').trim().charAt(0).toUpperCase()}
        </Text>
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
  title: { ...type.title, color: text.primary },
  subtitle: { ...type.caption, color: text.muted, marginTop: 2 },
  // A pill, filled, no outline — the shape a search box has had on every
  // phone since about 2019.
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 16, marginBottom: space.md, paddingHorizontal: 16, height: 46,
    borderRadius: 23, backgroundColor: surface.card, ...shadow.card,
  },
  search: { flex: 1, fontSize: 15, color: text.primary, padding: 0 },
  row: {
    flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12,
  },
  avatar: {
    width: 44, height: 44, borderRadius: radius.pill, backgroundColor: tone.wash,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarUnread: { backgroundColor: brand.base },
  avatarText: { fontSize: 17, fontWeight: '700', color: tone.ink },
  avatarTextUnread: { color: brand.onBase },
  dot: {
    position: 'absolute', top: -1, right: -1, width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#FF6B4A', borderWidth: 2, borderColor: surface.page,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  from: { flex: 1, fontSize: 15, color: text.primary },
  when: { ...type.caption, color: text.muted },
  subject: { fontSize: 15, color: text.primary, marginTop: 2 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
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
    position: 'absolute', right: 20, bottom: 28, width: 60, height: 60, borderRadius: 30,
    backgroundColor: brand.base, alignItems: 'center', justifyContent: 'center', ...shadow.glow,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  sortLine: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8,
  },
  sortLineText: { fontSize: 13, color: brand.base, fontWeight: '600' },
  sortNoticeText: { fontSize: 13, lineHeight: 19, color: text.secondary, paddingHorizontal: 20, paddingBottom: 8 },
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
  mailboxMeta: { fontSize: 12, color: text.muted, marginTop: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingBottom: 6 },
  chip: { backgroundColor: tone.wash, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, maxWidth: '100%' },
  chipNeg: { backgroundColor: '#FBEAF0' },
  chipText: { fontSize: 12, color: tone.ink, fontWeight: '600' },
  binNote: { fontSize: 11, color: text.muted, paddingHorizontal: 16, paddingBottom: 6 },
  helpLead: { fontSize: 13, color: text.secondary, lineHeight: 18, marginBottom: 8 },
  helpStrong: { fontWeight: '700', color: text.primary },
  helpRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: surface.border },
  helpExample: { fontSize: 14, fontWeight: '600', color: text.primary },
  helpHint: { fontSize: 12, color: text.muted, marginTop: 1 },
  helpFoot: { fontSize: 12, color: text.muted, lineHeight: 17, marginTop: 10 },
  advField: { marginBottom: 8 },
  advLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: text.muted, marginBottom: 4, marginTop: 4 },
  advInput: { height: 40, borderRadius: 10, backgroundColor: surface.page, borderWidth: 1, borderColor: surface.border, paddingHorizontal: 10, fontSize: 14, color: text.primary },
  advChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  advChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: surface.page, borderWidth: 1, borderColor: surface.border },
  advChipOn: { backgroundColor: brand.base, borderColor: brand.base },
  advChipText: { fontSize: 12, color: text.primary, fontWeight: '600' },
  advChipTextOn: { color: brand.onBase },
  advSwitch: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  advPreview: { fontSize: 13, color: tone.ink, backgroundColor: tone.wash, borderRadius: 8, padding: 8, marginTop: 8 },
  advGo: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 23, backgroundColor: brand.base, marginTop: 10 },
  advGoText: { color: brand.onBase, fontSize: 15, fontWeight: '700' },
  // Amber, like the web's banner: a state the person should keep noticing
  // while it lasts, not an error and not a notice they can dismiss.
  shared: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10,
    backgroundColor: '#FDF4E3', borderWidth: 1, borderColor: '#F0DDB8',
  },
  sharedText: { flex: 1, fontSize: 13, lineHeight: 18, color: '#7A5100' },
  sharedStrong: { fontWeight: '700' },
});
