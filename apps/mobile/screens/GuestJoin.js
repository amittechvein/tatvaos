/**
 * Joining a meeting without a TatvaOS account.
 *
 * Amit, 23 Sept 2026: "if guest they dont have account on tatvaos they also
 * able to join the meeting via app … or enter meeting code and join as guest".
 *
 * ── WHY THIS SCREEN EXISTS AT ALL ──────────────────────────────────────────
 *  Until now every screen in this app sat behind sign-in. This is the first
 *  one that does not, so it is also the first that must never touch the
 *  session: no token is read here, none is stored, and the two calls it makes
 *  are the server's anonymous ones. A guest who finishes here has a LiveKit
 *  token for ONE meeting and nothing else — no account, no refresh token,
 *  nothing in the keychain.
 *
 *  The knock itself is NOT made here. This screen collects a code and a name,
 *  then hands both to the meeting screen, because that is where the waiting
 *  room, the password retry and the reconnection already live and where they
 *  are already proven on a phone. Two places that can enter a meeting is how
 *  the waiting room gets fixed in one of them.
 *
 *  The doorstep call is only so a person sees WHICH meeting they are about to
 *  walk into before they type their name. It writes nothing and costs nothing.
 * ───────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { doorstep, codeFrom } from '../lib/connect';
import { brand, surface, text, radius, space, type, shadow, tone } from '../theme';

export default function GuestJoin({ initialCode = '', onJoin, onBack }) {
  const [pasted, setPasted] = useState(initialCode);
  const [name, setName] = useState('');
  const [door, setDoor] = useState(null);      // the doorstep answer, once we have one
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');

  const code = codeFrom(pasted);

  // A code that arrived in a link is looked up at once: the person followed an
  // invitation, so the meeting's name is the first thing they should see.
  useEffect(() => {
    if (initialCode && codeFrom(initialCode)) look(codeFrom(initialCode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  async function look(c) {
    setLooking(true);
    setError('');
    try {
      const d = await doorstep(c);
      if (d.kind === 'closed') { setDoor(null); setError(d.message); return; }
      setDoor(d);
    } catch (e) {
      // Not a closed door: the server could not be reached at all. Saying
      // "this link does not work" here would send someone off to hunt for a
      // better link when the problem is the train tunnel they are in.
      setDoor(null);
      setError(e?.message || 'Could not reach TatvaOS.');
    } finally {
      setLooking(false);
    }
  }

  const stateLine = (d) => {
    if (d.locked) return 'This meeting is locked.';
    if (d.state === 'ended') return 'This meeting has ended.';
    if (d.state === 'active') return 'Happening now';
    return 'Not started yet';
  };

  const canJoin = door && name.trim().length > 0 && !door.locked && door.state !== 'ended';

  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }}
                            behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.header}>
          <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={26} color={text.primary} />
          </Pressable>
          <Text style={s.title}>Join a meeting</Text>
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Text style={s.lead}>
            You do not need a TatvaOS account. Paste the link you were sent, or type the
            meeting code.
          </Text>

          <Text style={s.label}>Meeting link or code</Text>
          <TextInput
            style={s.input}
            value={pasted}
            onChangeText={(v) => { setPasted(v); setDoor(null); setError(''); }}
            placeholder="https://connect.tatvaos.com/connect/room/…"
            placeholderTextColor={text.muted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!looking}
            accessibilityLabel="Meeting link or code"
          />

          {!door ? (
            <Pressable
              style={[s.primary, (!code || looking) && s.disabled]}
              onPress={() => look(code)}
              disabled={!code || looking}
              accessibilityLabel="Find this meeting"
            >
              {looking
                ? <ActivityIndicator color={brand.onBase} />
                : <Text style={s.primaryText}>Continue</Text>}
            </Pressable>
          ) : null}

          {error ? <Text style={s.error} accessibilityLabel={`Problem: ${error}`}>{error}</Text> : null}

          {door ? (
            <View style={s.card}>
              <Text style={s.cardEyebrow}>MEETING</Text>
              <Text style={s.cardTitle} numberOfLines={2}>{door.title || 'Meeting'}</Text>
              <Text style={s.cardWhen}>{stateLine(door)}</Text>

              {/* The same sentence the web shows a guest, in the same place.
                  Somebody about to be transcribed is told before they join,
                  not after. */}
              {door.minutesLive ? (
                <View style={s.disclosure}>
                  <Ionicons name="document-text-outline" size={15} color={tone.ink} />
                  <Text style={s.disclosureText}>
                    This meeting is captioned live, and notes are written from what is said.
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {door && !door.locked && door.state !== 'ended' ? (
            <>
              <Text style={s.label}>Your name</Text>
              <TextInput
                style={s.input}
                value={name}
                onChangeText={setName}
                placeholder="What everyone will see"
                placeholderTextColor={text.muted}
                maxLength={100}
                autoCapitalize="words"
                accessibilityLabel="Your name"
              />

              {/* The password is NOT collected here. The meeting screen asks
                  for it if the server says so, and it already handles a wrong
                  one — asking twice in two places is how they drift apart. */}
              <Pressable
                style={[s.primary, !canJoin && s.disabled]}
                onPress={() => onJoin({
                  code,
                  displayName: name.trim(),
                  meeting: { id: null, title: door.title || 'Meeting', joinUrl: null },
                })}
                disabled={!canJoin}
                accessibilityLabel="Join this meeting"
              >
                <Ionicons name="videocam" size={18} color={brand.onBase} />
                <Text style={s.primaryText}>Join as guest</Text>
              </Pressable>

              {door.passwordRequired ? (
                <Text style={s.hint}>This meeting has a password. You will be asked for it next.</Text>
              ) : null}
              <Text style={s.hint}>
                The host may need to let you in. You will see a waiting screen until they do.
              </Text>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.page },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: space.md,
  },
  title: { ...type.title, color: text.primary },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xxl },
  lead: { ...type.body, color: text.secondary, marginBottom: space.lg },

  label: { ...type.caption, color: text.secondary, marginBottom: 6, marginLeft: 4 },
  input: {
    minHeight: 52, borderRadius: radius.md, backgroundColor: surface.card,
    borderWidth: 1, borderColor: surface.border,
    paddingHorizontal: space.md + 2, paddingVertical: 12,
    fontSize: 16, color: text.primary, marginBottom: space.md,
  },

  primary: {
    height: 54, borderRadius: 27, backgroundColor: brand.base,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    marginTop: space.sm, ...shadow.glow,
  },
  disabled: { opacity: 0.45 },
  primaryText: { color: brand.onBase, fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },

  card: {
    backgroundColor: tone.deep, borderRadius: radius.lg,
    padding: space.lg, marginTop: space.md, marginBottom: space.lg, ...shadow.card,
  },
  cardEyebrow: { ...type.eyebrow, color: tone.onDeepMuted, marginBottom: 4 },
  cardTitle: { ...type.heading, color: tone.onDeep },
  cardWhen: { ...type.caption, fontWeight: '400', fontSize: 13, color: tone.onDeepMuted, marginTop: 3 },
  disclosure: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
    backgroundColor: surface.card, borderRadius: radius.sm,
    padding: space.md, marginTop: space.md,
  },
  disclosureText: { flex: 1, ...type.caption, fontWeight: '400', color: text.secondary, lineHeight: 17 },

  error: { ...type.body, color: '#A32D2D', marginTop: space.md },
  hint: { ...type.caption, fontWeight: '400', color: text.muted, marginTop: space.md, lineHeight: 17 },
});
