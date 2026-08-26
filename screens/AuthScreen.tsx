import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';

export default function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === 'signUp';

  async function submit() {
    if (!email.trim() || !password) {
      Alert.alert('Missing details', 'Enter both an email address and a password.');
      return;
    }
    setBusy(true);
    const { error } = isSignUp ? await signUp(email, password) : await signIn(email, password);
    setBusy(false);

    if (error) {
      Alert.alert(isSignUp ? 'Could not sign up' : 'Could not log in', error);
      return;
    }
    if (isSignUp) {
      Alert.alert(
        'Check your email',
        'If email confirmation is enabled on your Supabase project, confirm the address before logging in.'
      );
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>TripVault</Text>
        <Text style={styles.subtitle}>
          {isSignUp ? 'Create your account' : 'Log in to your account'}
        </Text>

        {!isSupabaseConfigured && (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>Supabase isn't configured yet</Text>
            <Text style={styles.noticeBody}>
              Copy .env.example to .env and add your project URL and anon key, then restart with
              {'\u00A0'}npx expo start --clear. Until then sign-up and log-in will fail.
            </Text>
          </View>
        )}

        <TextInput
          style={styles.input}
          placeholder="Email address"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          editable={!busy}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          textContentType={isSignUp ? 'newPassword' : 'password'}
          editable={!busy}
        />

        <Pressable
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={submit}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{isSignUp ? 'Sign up' : 'Log in'}</Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => setMode(isSignUp ? 'signIn' : 'signUp')}
          disabled={busy}
          hitSlop={8}
        >
          <Text style={styles.switch}>
            {isSignUp ? 'Already have an account? Log in' : "New here? Create an account"}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#fff' },
  container: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 32, fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#555', textAlign: 'center', marginBottom: 12 },
  notice: {
    backgroundColor: '#FFF4E5',
    borderColor: '#F0B429',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  noticeTitle: { fontWeight: '600', color: '#7A4E00' },
  noticeBody: { color: '#7A4E00', fontSize: 13, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#1B6EF3',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  switch: { textAlign: 'center', color: '#1B6EF3', marginTop: 8 },
});
