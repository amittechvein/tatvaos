// TatvaOS mobile — first runnable slice.
//
// TWO SCREENS ONLY, and the login does NOT call the real API yet. Any email
// and password gets you in. That is deliberate for this slice: the point is
// to look at the shapes on a real phone before anyone wires authentication,
// and a fake login cannot leak a real credential.
//
// WHAT IS NOT HERE, so nobody mistakes this for the product:
//   - real authentication against core.tatvaos.com
//   - the web views that open each product
//   - Connect, which is the whole reason the app exists (screen sharing)
//   - token storage in the keychain
//
// See docs/MOBILE_LANE_BRIEF.md §4 for the v1 scope this grows into.

import { useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView,
  SafeAreaView, StyleSheet, Platform, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { brand, text, surface, products } from './theme';

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  return signedIn
    ? <Dashboard onSignOut={() => setSignedIn(false)} />
    : <Login onSignIn={() => setSignedIn(true)} />;
}

function Login({ onSignIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');

  // Validate before acting. An empty form that silently does nothing is the
  // commonest small cruelty in a mobile app.
  const submit = () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password');
      return;
    }
    setError('');
    onSignIn();
  };

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.loginBody}>
        <View style={s.logo}><Text style={s.logoLetter}>T</Text></View>

        <Text style={s.h1}>Sign in</Text>
        <Text style={s.sub}>Your school's workspace</Text>

        <Text style={s.label}>Email</Text>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={(v) => { setEmail(v); setError(''); }}
          placeholder="name@school.edu.in"
          placeholderTextColor={text.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
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
          />
          <Pressable onPress={() => setShow(!show)} hitSlop={10} accessibilityLabel="Show password">
            <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={20} color={text.muted} />
          </Pressable>
        </View>

        {error ? <Text style={s.error}>{error}</Text> : null}

        <Pressable style={s.primary} onPress={submit}>
          <Text style={s.primaryText}>Sign in</Text>
        </Pressable>

        <Pressable hitSlop={8}><Text style={s.quiet}>Forgot password</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

function Dashboard({ onSignOut }) {
  return (
    <SafeAreaView style={s.screen}>
      <ScrollView contentContainerStyle={s.dashBody}>
        <View style={s.header}>
          <View>
            <Text style={s.h2}>Good morning</Text>
            <Text style={s.sub}>Don Bosco School</Text>
          </View>
          <Pressable style={s.avatar} onPress={onSignOut} accessibilityLabel="Account">
            <Text style={s.avatarText}>AD</Text>
          </Pressable>
        </View>

        <View style={s.grid}>
          {products.map((p) => (
            <Pressable key={p.key} style={s.tile} accessibilityLabel={p.name}>
              <View style={[s.tileIcon, { backgroundColor: p.tint }]}>
                <Ionicons name={p.icon} size={24} color={p.ink} />
              </View>
              <Text style={s.tileLabel}>{p.name}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={[s.label, { marginTop: 26 }]}>Next meeting</Text>
        <View style={s.meeting}>
          <Ionicons name="videocam-outline" size={20} color="#185FA5" />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={s.meetingTitle}>Staff briefing</Text>
            <Text style={s.meetingWhen}>10:30 · 4 people</Text>
          </View>
          <Pressable style={s.join}><Text style={s.joinText}>Join</Text></Pressable>
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

  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 },
  tile: { width: '33.33%', paddingHorizontal: 6, marginBottom: 14, alignItems: 'center' },
  tileIcon: {
    width: '100%', height: 66, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  tileLabel: { fontSize: 13, color: text.primary, marginTop: 7 },

  meeting: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: surface.card,
    borderWidth: 1, borderColor: surface.border, borderRadius: 10, padding: 12,
  },
  meetingTitle: { fontSize: 15, color: text.primary },
  meetingWhen: { fontSize: 13, color: text.secondary, marginTop: 1 },
  join: {
    borderWidth: 1, borderColor: brand.greenPale, borderRadius: 8,
    paddingVertical: 6, paddingHorizontal: 14,
  },
  joinText: { fontSize: 13, fontWeight: '500', color: brand.green },
});
