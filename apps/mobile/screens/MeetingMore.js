/**
 * "More" in a meeting: people, chat, recording, settings.
 *
 * Amit, 23 Sept 2026: "mobile app give more option by using more option
 * able to check chat, people, recording on/off, advance setting".
 *
 * This is the sheet and nothing else. It owns no network and no LiveKit: it
 * draws what Meeting.js knows and calls back for every action, so the room's
 * one connection and one token stay in the one file that already has them.
 * The web room behind the same button (Stage.tsx) is the reference for
 * wording, which control appears to whom, and which of these are the
 * server's to enforce (roles, recording, settings) and which are the
 * client's (chat policy, hands).
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, Modal, StyleSheet, Alert, Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { brand, radius, type, tone } from '../theme';

const TABS = [
  ['people', 'People', 'people-outline'],
  ['chat', 'Chat', 'chatbubble-ellipses-outline'],
  ['record', 'Record', 'radio-button-on-outline'],
  ['settings', 'Settings', 'options-outline'],
];

/** user:{id}#device -> user:{id}; the part that names the person. */
export const personOf = (identity) => String(identity ?? '').split('#')[0];

const nameOf = (p) => (p?.name || p?.identity || 'Someone').replace(/^user:|^guest:/, '');

export default function MeetingMore({
  visible, onClose, tab: initialTab = 'people',
  // who
  role, isGuest, mode,
  // people
  participants = [], hands = new Set(), roles = new Map(), myHand = false,
  onToggleHand, onMute, onRemove, onSetRole, onMuteAll, onEnd,
  // chat
  chat = [], chatPolicy = 'everyone', unreadChat = 0, onSendChat,
  // recording
  recording = { enabled: true, live: null, active: false }, onStartRecording, onStopRecording,
  // settings (host/cohost)
  settings = {}, onPatchSetting,
}) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState('');
  const host = role === 'host';
  const manager = role === 'host' || role === 'cohost';
  const mayChat = chatPolicy === 'everyone' || (chatPolicy === 'cohost' && manager);

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    onSendChat?.(t);
    setDraft('');
  };

  const confirm = (title, body, ok, then) => Alert.alert(title, body, [
    { text: 'Cancel', style: 'cancel' },
    { text: ok, style: 'destructive', onPress: then },
  ]);

  const handsFirst = [...participants].sort((a, b) => Number(hands.has(b.identity)) - Number(hands.has(a.identity)));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={[s.sheet, { paddingBottom: 12 + insets.bottom }]} onPress={() => {}}>
          <View style={s.grabber} />
          <View style={s.tabs} accessibilityRole="tablist">
            {TABS.filter(([k]) => k !== 'settings' || manager).map(([k, label, icon]) => (
              <Pressable key={k} style={[s.tab, tab === k && s.tabOn]} onPress={() => setTab(k)}
                         accessibilityRole="tab" accessibilityState={{ selected: tab === k }}
                         accessibilityLabel={label}>
                <Ionicons name={icon} size={18} color={tab === k ? brand.onBase : '#C9C4D8'} />
                <Text style={[s.tabText, tab === k && s.tabTextOn]}>{label}</Text>
                {k === 'chat' && unreadChat > 0 && tab !== 'chat' ? (
                  <View style={s.badge}><Text style={s.badgeText}>{unreadChat}</Text></View>
                ) : null}
              </Pressable>
            ))}
          </View>

          {tab === 'people' ? (
            <View style={s.body}>
              <Pressable style={[s.row, s.action, myHand && s.actionOn]} onPress={onToggleHand}
                         accessibilityLabel={myHand ? 'Lower hand' : 'Raise hand'}>
                <Ionicons name="hand-right-outline" size={20} color={myHand ? brand.onBase : '#EAE6F3'} />
                <Text style={[s.actionText, myHand && { color: brand.onBase }]}>
                  {myHand ? 'Lower my hand' : 'Raise my hand'}
                </Text>
              </Pressable>

              <Text style={s.section}>{participants.length} IN THE MEETING</Text>
              <ScrollView style={s.list}>
                {handsFirst.map((p) => {
                  const mine = p.isLocal;
                  const micOn = !!p.isMicrophoneEnabled;
                  const r = roles.get(personOf(p.identity));
                  const guest = String(p.identity).startsWith('guest:');
                  return (
                    <View key={p.identity} style={s.row}
                          accessibilityLabel={`${nameOf(p)}${mine ? ', you' : ''}${hands.has(p.identity) ? ', hand raised' : ''}${micOn ? '' : ', muted'}`}>
                      <View style={s.avatar}><Text style={s.avatarText}>{nameOf(p).slice(0, 1).toUpperCase()}</Text></View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={s.name} numberOfLines={1}>
                          {nameOf(p)}{mine ? ' (you)' : ''}
                        </Text>
                        <Text style={s.meta} numberOfLines={1}>
                          {r === 'host' ? 'Host' : r === 'cohost' ? 'Co-host' : guest ? 'Guest' : 'Participant'}
                          {p.isScreenShareEnabled ? ' · sharing' : ''}
                        </Text>
                      </View>
                      {hands.has(p.identity) ? <Ionicons name="hand-right" size={18} color="#FFD166" /> : null}
                      <Ionicons name={micOn ? 'mic' : 'mic-off'} size={18} color={micOn ? '#7CE8B5' : '#FFB4AB'} />
                      {manager && !mine ? (
                        <Pressable hitSlop={8} accessibilityLabel={`Options for ${nameOf(p)}`}
                                   onPress={() => Alert.alert(nameOf(p), undefined, [
                                     ...(micOn ? [{ text: 'Mute microphone', onPress: () => onMute?.(p.identity, 'audio') }] : []),
                                     ...(p.isCameraEnabled ? [{ text: 'Turn camera off', onPress: () => onMute?.(p.identity, 'video') }] : []),
                                     ...(p.isScreenShareEnabled ? [{ text: 'Stop their share', onPress: () => onMute?.(p.identity, 'screen') }] : []),
                                     ...(host && !guest ? [{
                                       text: r === 'cohost' ? 'Remove as co-host' : 'Make co-host',
                                       onPress: () => onSetRole?.(p.identity, r === 'cohost' ? 'participant' : 'cohost'),
                                     }] : []),
                                     { text: 'Remove from meeting', style: 'destructive',
                                       onPress: () => confirm('Remove?', `${nameOf(p)} will be removed${guest ? '' : ' and cannot rejoin'}.`, 'Remove', () => onRemove?.(p.identity)) },
                                     { text: 'Cancel', style: 'cancel' },
                                   ])}>
                          <Ionicons name="ellipsis-vertical" size={18} color="#C9C4D8" />
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>

              {manager ? (
                <View style={s.hostRow}>
                  <Pressable style={s.ghost} onPress={() => confirm('Mute everyone?', 'Hosts and co-hosts stay unmuted. People can unmute themselves.', 'Mute all', () => onMuteAll?.('everyone'))}
                             accessibilityLabel="Mute everyone">
                    <Ionicons name="mic-off-outline" size={16} color="#EAE6F3" />
                    <Text style={s.ghostText}>Mute all</Text>
                  </Pressable>
                  <Pressable style={[s.ghost, s.ghostDanger]} onPress={() => confirm('End the meeting?', 'Everyone will be disconnected.', 'End for all', () => onEnd?.())}
                             accessibilityLabel="End meeting for everyone">
                    <Ionicons name="stop-circle-outline" size={16} color="#FFB4AB" />
                    <Text style={[s.ghostText, { color: '#FFB4AB' }]}>End for all</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}

          {tab === 'chat' ? (
            <View style={s.body}>
              <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 8 }}>
                {chat.length === 0 ? <Text style={s.empty}>Nothing said yet.</Text> : null}
                {chat.map((m) => (
                  <View key={m.cid} style={[s.bubble, m.mine && s.bubbleMine]}
                        accessibilityLabel={`${m.mine ? 'You' : m.name}: ${m.text}`}>
                    {!m.mine ? <Text style={s.bubbleName}>{m.name}</Text> : null}
                    <Text style={s.bubbleText}>{m.text}</Text>
                  </View>
                ))}
              </ScrollView>
              {mayChat ? (
                <View style={s.composer}>
                  <TextInput style={s.input} value={draft} onChangeText={setDraft}
                             placeholder="Message everyone" placeholderTextColor="#7C7890"
                             maxLength={2000} returnKeyType="send" onSubmitEditing={send}
                             accessibilityLabel="Message" />
                  <Pressable style={[s.sendBtn, !draft.trim() && { opacity: 0.4 }]} onPress={send}
                             disabled={!draft.trim()} accessibilityLabel="Send message">
                    <Ionicons name="send" size={18} color={brand.onBase} />
                  </Pressable>
                </View>
              ) : (
                <Text style={s.empty}>
                  {chatPolicy === 'off' ? 'Chat is off for this meeting.' : 'Only the host and co-hosts can send messages.'}
                </Text>
              )}
            </View>
          ) : null}

          {tab === 'record' ? (
            <View style={s.body}>
              {mode === 'private' ? (
                <Text style={s.empty}>A private meeting cannot be recorded.</Text>
              ) : !recording.enabled ? (
                <Text style={s.empty}>Recording is not switched on for your organisation.</Text>
              ) : !manager ? (
                <Text style={s.empty}>
                  {recording.active ? 'This meeting is being recorded.' : 'Only the host can record. You are told on screen when it starts.'}
                </Text>
              ) : recording.active || recording.live ? (
                <>
                  <Text style={s.lead}>Recording is running. It cannot be paused, only stopped.</Text>
                  <Pressable style={[s.action, s.actionDanger]} onPress={onStopRecording}
                             accessibilityLabel="Stop recording">
                    <Ionicons name="stop-circle" size={20} color="#FFFFFF" />
                    <Text style={[s.actionText, { color: '#FFFFFF' }]}>Stop recording</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={s.lead}>
                    Everyone here is told a recording has started, and it cannot be paused.
                  </Text>
                  <Pressable style={[s.action, s.actionOn]} onPress={() => confirm('Start recording?', 'Everyone in the meeting is told. It cannot be paused.', 'Start', () => onStartRecording?.('video'))}
                             accessibilityLabel="Start recording">
                    <Ionicons name="radio-button-on" size={20} color={brand.onBase} />
                    <Text style={[s.actionText, { color: brand.onBase }]}>Start recording</Text>
                  </Pressable>
                </>
              )}
            </View>
          ) : null}

          {tab === 'settings' && manager ? (
            <ScrollView style={s.body}>
              <Setting label="Who can share their screen" value={settings.sharePolicy ?? 'everyone'}
                       options={[['everyone', 'Everyone'], ['cohost', 'Hosts and co-hosts'], ['host', 'Host only']]}
                       onChange={(v) => onPatchSetting?.({ sharePolicy: v })} />
              <Setting label="Screens at once" value={settings.shareMode ?? 'multiple'}
                       options={[['multiple', 'Several'], ['single', 'One at a time']]}
                       onChange={(v) => onPatchSetting?.({ shareMode: v })} />
              <Setting label="Chat" value={settings.chatPolicy ?? 'everyone'}
                       options={[['everyone', 'Everyone'], ['cohost', 'Hosts and co-hosts'], ['off', 'Off']]}
                       onChange={(v) => onPatchSetting?.({ chatPolicy: v })} />
              <Setting label="Waiting room" value={settings.waitingRoom ?? 'guests'}
                       options={[['off', 'Off'], ['guests', 'Guests wait'], ['everyone', 'Everyone waits']]}
                       onChange={(v) => onPatchSetting?.({ waitingRoom: v })} />
              <View style={[s.row, { paddingVertical: 12 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>Live minutes</Text>
                  <Text style={s.meta}>Captions and notes written from what is said. Captions come from web browsers in the meeting.</Text>
                </View>
                <Switch value={settings.minutesLive === true}
                        onValueChange={(v) => onPatchSetting?.({ minutesLive: v })}
                        accessibilityLabel="Live minutes" />
              </View>
              <View style={[s.row, { paddingVertical: 12 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>Lock the meeting</Text>
                  <Text style={s.meta}>Nobody else can join, even with the link.</Text>
                </View>
                <Switch value={settings.locked === true}
                        onValueChange={(v) => onPatchSetting?.({ locked: v })}
                        accessibilityLabel="Lock the meeting" />
              </View>
            </ScrollView>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Setting({ label, value, options, onChange }) {
  return (
    <View style={s.setting}>
      <Text style={s.settingLabel}>{label}</Text>
      <View style={s.chips}>
        {options.map(([v, text]) => (
          <Pressable key={v} style={[s.chip, value === v && s.chipOn]} onPress={() => onChange(v)}
                     accessibilityRole="radio" accessibilityState={{ selected: value === v }}
                     accessibilityLabel={`${label}: ${text}`}>
            <Text style={[s.chipText, value === v && s.chipTextOn]}>{text}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#1B1240', borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    paddingHorizontal: 16, paddingTop: 8, maxHeight: '82%', minHeight: '55%',
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: 10 },
  tabs: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 9, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.08)',
  },
  tabOn: { backgroundColor: brand.base },
  tabText: { fontSize: 12, fontWeight: '700', color: '#C9C4D8' },
  tabTextOn: { color: brand.onBase },
  badge: { backgroundColor: '#FF6B4A', borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  body: { flexShrink: 1 },
  section: { ...type.eyebrow, color: '#9C99AB', marginTop: 12, marginBottom: 6 },
  list: { flexGrow: 0, maxHeight: 340 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: brand.base, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: brand.onBase, fontWeight: '800', fontSize: 15 },
  name: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  meta: { color: '#9C99AB', fontSize: 12, marginTop: 1 },
  action: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 46, borderRadius: 23, backgroundColor: 'rgba(255,255,255,0.10)', marginTop: 4,
  },
  actionOn: { backgroundColor: brand.base },
  actionDanger: { backgroundColor: '#E5484D' },
  actionText: { color: '#EAE6F3', fontSize: 15, fontWeight: '700' },
  hostRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  ghost: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.10)',
  },
  ghostDanger: { backgroundColor: 'rgba(229,72,77,0.18)' },
  ghostText: { color: '#EAE6F3', fontSize: 13, fontWeight: '700' },
  empty: { color: '#9C99AB', fontSize: 14, lineHeight: 20, paddingVertical: 14, textAlign: 'center' },
  lead: { color: '#C9C4D8', fontSize: 14, lineHeight: 20, paddingVertical: 10 },
  bubble: { alignSelf: 'flex-start', maxWidth: '86%', backgroundColor: 'rgba(255,255,255,0.10)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: brand.base },
  bubbleName: { color: tone.soft ?? '#B39BF2', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  bubbleText: { color: '#FFFFFF', fontSize: 15, lineHeight: 20 },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  input: {
    flex: 1, height: 44, borderRadius: 22, paddingHorizontal: 16, color: '#FFFFFF', fontSize: 15,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: brand.base, alignItems: 'center', justifyContent: 'center' },
  setting: { paddingVertical: 10 },
  settingLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.10)' },
  chipOn: { backgroundColor: brand.base },
  chipText: { color: '#C9C4D8', fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: brand.onBase },
});
