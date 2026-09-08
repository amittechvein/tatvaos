// TatvaOS mobile — real sign-in against production.
//
// The login is no longer fake. It calls POST /api/auth/login on
// core.tatvaos.com, stores the refresh token in the device keychain, and
// brings the person back signed in on the next launch.
//
// WHAT IS STILL NOT HERE, so nobody mistakes this for the product:
//   - the web views that open each product. Tapping a tile does nothing yet,
//     and that is the next real piece of work. It is NOT a small one: the web
//     apps authenticate by cookie and this app holds a token, so "just open a
//     WebView" would land the person on a login page inside the app.
//   - Connect, which is the whole reason the app exists (screen sharing)
//   - changing a password in-app (we show the prompt and point at the web)
//
// See docs/MOBILE_LANE_BRIEF.md §4 for the v1 scope this grows into.

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  SafeAreaView, StyleSheet, Platform, StatusBar, Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { brand, text, surface, visibleProducts } from './theme';
import { login, verifyMfa, restore, signOut, me } from './api';

export default function App() {
  // restoring → login → (mfa) → in
  const [phase, setPhase] = useState('restoring');
  const [session, setSession] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [profile, setProfile] = useState(null);

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
    await signOut(token);
  }, [session]);

  if (phase === 'restoring') return <Splash />;
  if (phase === 'in') return <Dashboard session={session} profile={profile} onSignOut={onSignOut} />;
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
      <ActivityIndicator color={brand.green} style={{ marginTop: 20 }} />
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
            ? <ActivityIndicator color={brand.greenLight} />
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
            ? <ActivityIndicator color={brand.greenLight} />
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

function Dashboard({ session, profile, onSignOut }) {
  const user = profile?.user ?? session?.user ?? {};
  // Falls back to the email while /me is in flight or if it failed. Showing
  // an address the person recognises beats showing a placeholder name.
  const name = user.displayName || user.email || 'Signed in';
  const org = profile?.organisation?.name || user.email || '';
  const tiles = visibleProducts(profile?.products, user.role);

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

        <View style={s.grid}>
          {tiles.map((p) => (
            <Pressable key={p.key} style={s.tile} accessibilityLabel={p.name}>
              <View style={[s.tileIcon, { backgroundColor: p.tint }]}>
                <Ionicons name={p.icon} size={24} color={p.ink} />
              </View>
              <Text style={s.tileLabel}>{p.name}</Text>
            </Pressable>
          ))}
        </View>
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
    width: 52, height: 52, borderRadius: 13, backgroundColor: brand.green,
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  logoLetter: { color: brand.greenLight, fontSize: 22, fontWeight: '500' },

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
    height: 48, borderRadius: 8, backgroundColor: brand.green,
    alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  primaryBusy: { opacity: 0.7 },
  primaryText: { color: brand.greenLight, fontSize: 16, fontWeight: '500' },
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
  tileLabel: { fontSize: 13, color: text.primary, marginTop: 7 },
});
