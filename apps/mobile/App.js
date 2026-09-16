// TatvaOS mobile — real sign-in against production.
//
// The login is no longer fake. It calls POST /api/auth/login on
// core.tatvaos.com, stores the refresh token in the device keychain, and
// brings the person back signed in on the next launch.
//
// 8 Sept 2026: the tiles now OPEN. They hand off to the system browser rather
// than a WebView — see openProduct() for why that is the decision and not a
// shortcut. The cookie/token mismatch this file used to warn about is real and
// unchanged; the browser sidesteps it honestly, at the cost of one sign-in.
//
// 9 Sept 2026: Connect is NATIVE. The Connect tile opens screens/Meetings.js
// (your meetings, start one now) and screens/Meeting.js (the call: mic,
// camera, speaker, participant tiles, screen share, leave). Everything else
// still opens the web. Connect is the one product a phone browser cannot do -
// no mobile browser can share its screen - so it is the one that earned a
// native screen first. See docs/MOBILE_LANE_BRIEF.md §4.
//
// WHAT IS STILL NOT HERE, so nobody mistakes this for the product:
//   - native screens for Mail, Space, Calendar. Those are the web app in a
//     browser today.
//   - single sign-on into that browser. The app holds a token, the web apps
//     read a cookie. Raised with Core: a one-time handoff URL.
//   - changing a password in-app (we show the prompt and point at the web)
//   - scheduling a meeting from the phone. Meetings.js lists and starts;
//     planning one is still the web.

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  StyleSheet, Platform, StatusBar, Keyboard, Linking,
} from 'react-native';
// Not React Native's SafeAreaView: that one is a no-op on Android, and with
// targetSdk 36 the app draws edge-to-edge, so the title sat under the clock
// and the bottom row under the navigation bar. Seen on a Samsung, 10 Sept.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { brand, text, surface, visibleProducts } from './theme';
import { login, verifyMfa, restore, signOut, me } from './api';
import Meetings from './screens/Meetings';
import Meeting from './screens/Meeting';
import ScheduleMeeting from './screens/ScheduleMeeting';
import NextMeetingCard from './components/NextMeetingCard';
import { handoffUrl } from './lib/handoff';

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  // restoring → login → (mfa) → in
  const [phase, setPhase] = useState('restoring');
  const [session, setSession] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [profile, setProfile] = useState(null);

  // Where we are once signed in: home → meetings → meeting. No navigation
  // library yet; three screens do not justify one, and a plain state machine
  // is easier to reason about when a call is in progress.
  const [view, setView] = useState('home');
  const [activeMeeting, setActiveMeeting] = useState(null);

  // Come back signed in. A workspace app that asks for a password every time
  // it is opened is one people stop opening.
  //
  //  THE .catch IS THE POINT, 8 Sept 2026.
  //
  //  Without it this app could hang on the splash screen forever. restore()
  //  guards the NETWORK call, but SecureStore.getItemAsync sits outside that
  //  guard — a keychain read that throws (no secure hardware, a corrupt entry,
  //  a device policy change) rejected this promise, setPhase never ran, and the
  //  person was left watching a spinner with no error, no timeout and no way
  //  out. It cost an hour on the emulator: the login form could not be typed
  //  into because the login form was never on the screen.
  //
  //  Falling back to 'login' is the right failure: the worst case is being
  //  asked to sign in again, which is recoverable. A spinner is not.
  useEffect(() => {
    let cancelled = false;
    restore()
      .then((s) => {
        if (cancelled) return;
        if (s) { setSession(s); setPhase('in'); } else { setPhase('login'); }
      })
      .catch((e) => {
        if (cancelled) return;
        console.log(`[app] restore failed, showing sign-in: ${e?.message ?? e}`);
        setPhase('login');
      });
    return () => { cancelled = true; };
  }, []);

  // Name, organisation and entitlements. Deliberately NOT awaited before the
  // dashboard renders — the sign-in is already valid, and holding the screen
  // hostage to a second request just to print a school's name would make a
  // slow connection look like a failed login.
  useEffect(() => {
    if (!session) { setProfile(null); return; }
    let cancelled = false;
    me(session.accessToken)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch(() => { /* the dashboard has sensible fallbacks; see Dashboard */ });
    return () => { cancelled = true; };
  }, [session]);

  const onSignedIn = useCallback((s) => { setSession(s); setChallenge(null); setPhase('in'); }, []);

  const onSignOut = useCallback(async () => {
    const token = session?.accessToken;
    setSession(null); setProfile(null); setPhase('login');
    setView('home'); setActiveMeeting(null);
    await signOut(token);
  }, [session]);

  // Leaving a meeting goes back to wherever it was joined from. Joined from the
  // dashboard's next-meeting card, back to the dashboard; joined from Connect's
  // list, back to the list. Always sending people to the list would drop someone
  // who never opened it onto a screen they did not come from.
  const [meetingFrom, setMeetingFrom] = useState('meetings');

  const openConnect = useCallback(() => setView('meetings'), []);
  const joinMeeting = useCallback((m) => { setMeetingFrom('meetings'); setActiveMeeting(m); setView('meeting'); }, []);
  const joinFromHome = useCallback((m) => { setMeetingFrom('home'); setActiveMeeting(m); setView('meeting'); }, []);
  const leaveMeeting = useCallback(() => { setActiveMeeting(null); setView(meetingFrom); }, [meetingFrom]);
  const backHome = useCallback(() => setView('home'), []);
  const openSchedule = useCallback(() => setView('schedule'), []);

  // Back to the list rather than into the meeting: it is for later, and the
  // list is where it now appears. Meetings remounts, so it reloads itself and
  // the new row is there without anything having to push it.
  const scheduled = useCallback(() => setView('meetings'), []);

  if (phase === 'restoring') return <Splash />;
  if (phase === 'in') {
    if (view === 'meeting' && activeMeeting) {
      return <Meeting session={session} meeting={activeMeeting} onLeave={leaveMeeting} />;
    }
    if (view === 'schedule') {
      return (
        <ScheduleMeeting
          session={session}
          onCreated={scheduled}
          onBack={() => setView('meetings')}
        />
      );
    }
    if (view === 'meetings') {
      return (
        <Meetings
          session={session}
          onJoin={joinMeeting}
          onBack={backHome}
          onSchedule={openSchedule}
        />
      );
    }
    return (
      <Dashboard
        session={session}
        profile={profile}
        onSignOut={onSignOut}
        onOpenConnect={openConnect}
        onJoinMeeting={joinFromHome}
      />
    );
  }
  if (phase === 'mfa') {
    return (
      <MfaScreen
        challenge={challenge}
        onVerified={onSignedIn}
        onBack={() => { setChallenge(null); setPhase('login'); }}
      />
    );
  }
  return (
    <Login
      onSignedIn={onSignedIn}
      onChallenge={(c) => { setChallenge(c); setPhase('mfa'); }}
    />
  );
}

// ---------------------------------------------------------------------------

function Splash() {
  return (
    <SafeAreaView style={[s.screen, s.centre]}>
      <View style={s.logo}><Text style={s.logoLetter}>T</Text></View>
      <ActivityIndicator color={brand.base} style={{ marginTop: 20 }} />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

function Login({ onSignedIn, onChallenge }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    // Validate before acting. An empty form that silently does nothing is the
    // commonest small cruelty in a mobile app.
    if (!email.trim() || !password) {
      setError('Enter your email and password');
      return;
    }
    Keyboard.dismiss();
    setError('');
    setBusy(true);
    try {
      const result = await login(email.trim(), password);
      // A 200 from this endpoint is not always a sign-in — see api.js.
      if (result.kind === 'mfa') onChallenge(result.challenge);
      else onSignedIn(result.session);
    } catch (e) {
      // The server's sentence, shown as written: it names the lockout minutes
      // when there is a lockout, and stays vague about whether the account
      // exists when there is not.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.loginBody}>
        <View style={s.logo}><Text style={s.logoLetter}>T</Text></View>

        <Text style={s.h1}>Sign in</Text>
        <Text style={s.sub}>Your organisation's workspace</Text>

        <Text style={s.label}>Email</Text>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={(v) => { setEmail(v); setError(''); }}
          placeholder="name@school.edu.in"
          placeholderTextColor={text.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          editable={!busy}
          returnKeyType="next"
        />

        <Text style={s.label}>Password</Text>
        <View style={s.inputRow}>
          <TextInput
            style={s.inputBare}
            value={password}
            onChangeText={(v) => { setPassword(v); setError(''); }}
            placeholder="••••••••"
            placeholderTextColor={text.muted}
            secureTextEntry={!show}
            autoCapitalize="none"
            autoComplete="password"
            editable={!busy}
            returnKeyType="go"
            onSubmitEditing={submit}
          />
          <Pressable onPress={() => setShow(!show)} hitSlop={10} accessibilityLabel="Show password">
            <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={20} color={text.muted} />
          </Pressable>
        </View>

        {error ? <Text style={s.error}>{error}</Text> : null}

        <Pressable
          style={[s.primary, busy && s.primaryBusy]}
          onPress={submit}
          disabled={busy}
          accessibilityLabel="Sign in"
        >
          {busy
            ? <ActivityIndicator color={brand.onBase} />
            : <Text style={s.primaryText}>Sign in</Text>}
        </Pressable>

        <Pressable hitSlop={8}><Text style={s.quiet}>Forgot password</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

/**
 * The second factor.
 *
 * This screen exists because without it a user with two-factor turned on
 * cannot sign in AT ALL — the server answers their correct password with a
 * challenge and no token, and the app would sit there holding nothing.
 */
function MfaScreen({ challenge, onVerified, onBack }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (code.trim().length < 6) { setError('Enter the six-digit code'); return; }
    Keyboard.dismiss();
    setError('');
    setBusy(true);
    try {
      const result = await verifyMfa(challenge, code.trim());
      onVerified(result.session);
    } catch (e) {
      setError(e.message);
      // A challenge the server calls expired cannot be retried — the person
      // has to enter their password again. Send them back rather than let
      // them type six more digits into something that is already dead.
      if (e.status === 401) setTimeout(onBack, 1600);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.loginBody}>
        <Pressable onPress={onBack} hitSlop={10} style={{ marginBottom: 18 }}>
          <Ionicons name="arrow-back" size={22} color={text.secondary} />
        </Pressable>

        <Text style={s.h1}>Two-step verification</Text>
        <Text style={s.sub}>Enter the code from your authenticator app</Text>

        <TextInput
          style={[s.input, s.code]}
          value={code}
          onChangeText={(v) => { setCode(v.replace(/[^0-9]/g, '').slice(0, 6)); setError(''); }}
          placeholder="000000"
          placeholderTextColor={text.muted}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          maxLength={6}
          editable={!busy}
          autoFocus
        />

        {error ? <Text style={s.error}>{error}</Text> : null}

        <Pressable style={[s.primary, busy && s.primaryBusy]} onPress={submit} disabled={busy}>
          {busy
            ? <ActivityIndicator color={brand.onBase} />
            : <Text style={s.primaryText}>Verify</Text>}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function initials(name, email) {
  const source = (name || '').trim();
  if (source) {
    const parts = source.split(/\s+/);
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  return (email || '?').slice(0, 2).toUpperCase();
}

/**
 * Open a product.
 *
 * THE SYSTEM BROWSER, NOT A WEBVIEW, AND THAT IS THE WHOLE DECISION.
 *
 * The web apps authenticate by cookie; this app holds a token. A WebView would
 * therefore open on a login page INSIDE our own app — the person is signed in,
 * looking at a sign-in screen, with no way to tell why. Worse, a WebView we
 * control looks like our app, so typing a password into it teaches people that
 * a screen inside an app is a fine place to type a password. It is not, and
 * that is a habit worth not teaching.
 *
 * The system browser is honest: it shows the address bar and the padlock, it
 * already holds the person's session if they have signed in on this phone, and
 * a password manager can fill it. The cost is a sign-in the first time, and the
 * footnote on the dashboard says so rather than letting it surprise anyone.
 *
 * THE COST IS NOW USUALLY GONE — 16 Sept 2026. The sign-in handoff exists
 * (decision 0003): the app trades its token for a short-lived URL that opens
 * the browser ALREADY signed in, and lib/handoff.js asks for one per tile.
 * The reasoning above is unchanged and still the reason this is not a WebView:
 * the browser stays the browser, with its address bar and its padlock. What
 * changed is that the person no longer has to sign in again inside it.
 *
 * When there is no handoff to be had — the endpoint not deployed yet, a path
 * the server refuses, no network — this falls back to the plain URL, which is
 * exactly what it did before. One extra sign-in is a cost; a dead tile is a
 * bug, and the fallback is what keeps the second from happening.
 */
async function openProduct(p, token) {
  if (!p?.url) return;

  // Never log `target`: after a successful mint it carries a code that IS a
  // sign-in for the next sixty seconds. The name is enough to follow the flow.
  const target = (await handoffUrl(token, p.path)) ?? p.url;

  try {
    const ok = await Linking.canOpenURL(target);
    if (!ok) { console.log(`[app] no handler for ${p.name}'s address`); return; }
    console.log(`[app] opening ${p.name} in the browser`);
    await Linking.openURL(target);
  } catch (e) {
    // Never throw out of a tap. A dashboard that crashes because a browser is
    // missing is worse than a tile that does nothing, and this is now the
    // ONLY path where a tile does nothing - which the log records.
    console.log(`[app] could not open ${p.name}: ${e?.message ?? e}`);
  }
}

function Dashboard({ session, profile, onSignOut, onOpenConnect, onJoinMeeting }) {
  const user = profile?.user ?? session?.user ?? {};
  // Falls back to the email while /me is in flight or if it failed. Showing
  // an address the person recognises beats showing a placeholder name.
  const name = user.displayName || user.email || 'Signed in';
  const org = profile?.organisation?.name || user.email || '';
  const tiles = visibleProducts(profile?.products, user.role);

  // No Connect, no card: every meetings call would answer 403, and a card that
  // can only ever say "could not check" is worse than no card. visibleProducts
  // shows everything while /me is still in flight, so the card appears then and
  // disappears if the answer says this person has no Connect — see theme.js.
  const hasConnect = tiles.some((p) => p.key === 'connect');

  // Which tile is mid-open, if any. Asking for a handoff puts a network call
  // between the tap and the browser, and an unmarked control that does nothing
  // for a moment is one people press twice. The spinner is the difference
  // between "working" and "broken" — see lib/handoff.js for the deadline that
  // bounds how long this can last.
  const [opening, setOpening] = useState(null);

  const openTile = useCallback(async (p) => {
    setOpening(p.key);
    try {
      await openProduct(p, session?.accessToken);
    } finally {
      setOpening(null);
    }
  }, [session]);

  return (
    <SafeAreaView style={s.screen}>
      <ScrollView contentContainerStyle={s.dashBody}>
        <View style={s.header}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={s.h2} numberOfLines={1}>{greeting()}, {name.split(' ')[0]}</Text>
            <Text style={s.sub} numberOfLines={1}>{org}</Text>
          </View>
          <Pressable style={s.avatar} onPress={onSignOut} accessibilityLabel="Sign out">
            <Text style={s.avatarText}>{initials(user.displayName, user.email)}</Text>
          </Pressable>
        </View>

        {session?.mustChangePassword ? (
          <View style={s.notice}>
            <Ionicons name="key-outline" size={18} color="#8A5A00" />
            <Text style={s.noticeText}>
              Your password needs changing. Sign in on core.tatvaos.com to set a new one.
            </Text>
          </View>
        ) : null}

        {/* Above the tiles on purpose: the brief's reason for the card is that
            joining is the commonest thing someone opens this app to do, and a
            card below six tiles is a card nobody sees. */}
        {hasConnect ? (
          <NextMeetingCard
            session={session}
            onJoin={onJoinMeeting}
            onOpenConnect={onOpenConnect}
          />
        ) : null}

        <View style={s.grid}>
          {tiles.map((p) => {
            // Connect stays in the app. Every other tile leaves it, and the
            // tile says so - see the arrow below.
            const native = p.key === 'connect';
            return (
              <Pressable
                key={p.key}
                style={({ pressed }) => [s.tile, pressed && s.tilePressed]}
                onPress={() => (native ? onOpenConnect() : openTile(p))}
                disabled={opening === p.key}
                accessibilityRole={native ? 'button' : 'link'}
                accessibilityLabel={native ? p.name : `${p.name}, opens in your browser`}
                accessibilityState={{ busy: opening === p.key }}
              >
                <View style={[s.tileIcon, { backgroundColor: p.tint }]}>
                  {opening === p.key
                    ? <ActivityIndicator color={p.ink} />
                    : <Ionicons name={p.icon} size={24} color={p.ink} />}
                </View>
                <View style={s.tileLabelRow}>
                  <Text style={s.tileLabel}>{p.name}</Text>
                  {/* The arrow is not decoration. This leaves the app, and a
                      control that silently sends you elsewhere is the same
                      dishonesty as a tile that looks tappable and is not. A
                      native tile gets no arrow for the same reason: it stays. */}
                  {native ? null : <Ionicons name="open-outline" size={12} color={text.muted} />}
                </View>
              </Pressable>
            );
          })}
        </View>

        <Text style={s.dashFoot}>
          Connect runs in the app. Other products open in your browser for now;
          you may be asked to sign in there the first time.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: surface.page,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  centre: { alignItems: 'center', justifyContent: 'center' },

  loginBody: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  logo: {
    width: 52, height: 52, borderRadius: 13, backgroundColor: brand.base,
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  logoLetter: { color: brand.onBase, fontSize: 22, fontWeight: '500' },

  h1: { fontSize: 24, fontWeight: '500', color: text.primary, marginBottom: 4 },
  h2: { fontSize: 19, fontWeight: '500', color: text.primary },
  sub: { fontSize: 14, color: text.secondary, marginBottom: 24 },

  label: { fontSize: 13, color: text.secondary, marginBottom: 6 },
  input: {
    height: 46, borderWidth: 1, borderColor: surface.border, borderRadius: 8,
    backgroundColor: surface.card, paddingHorizontal: 12, fontSize: 15,
    color: text.primary, marginBottom: 16,
  },
  code: { fontSize: 22, letterSpacing: 8, textAlign: 'center', height: 54 },
  inputRow: {
    height: 46, borderWidth: 1, borderColor: surface.border, borderRadius: 8,
    backgroundColor: surface.card, paddingHorizontal: 12, marginBottom: 16,
    flexDirection: 'row', alignItems: 'center',
  },
  inputBare: { flex: 1, fontSize: 15, color: text.primary },
  error: { fontSize: 13, color: '#A32D2D', marginBottom: 12 },

  primary: {
    height: 48, borderRadius: 8, backgroundColor: brand.base,
    alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  primaryBusy: { opacity: 0.7 },
  primaryText: { color: brand.onBase, fontSize: 16, fontWeight: '500' },
  quiet: { fontSize: 14, color: text.secondary, textAlign: 'center', marginTop: 18 },

  dashBody: { paddingHorizontal: 20, paddingBottom: 32 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 18,
  },
  avatar: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: '#E6F1FB',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 13, fontWeight: '500', color: '#185FA5' },

  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#FDF4E3', borderWidth: 1, borderColor: '#F0DDB8',
    borderRadius: 10, padding: 12, marginBottom: 18,
  },
  noticeText: { flex: 1, fontSize: 13, color: '#7A5100', lineHeight: 18 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 },
  tile: { width: '33.33%', paddingHorizontal: 6, marginBottom: 14, alignItems: 'center' },
  tileIcon: {
    width: '100%', height: 66, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  // Pressed state exists because a tap with no feedback reads as a dead
  // control - which is precisely what these were until tonight.
  tilePressed: { opacity: 0.55 },
  tileLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 7 },
  tileLabel: { fontSize: 13, color: text.primary },
  dashFoot: {
    fontSize: 12, color: text.muted, marginTop: 6, paddingHorizontal: 6, lineHeight: 17,
  },
});
