import { Alert, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { ActionButton } from '../components/ActionButton';
import { Screen } from '../components/Screen';
import { readableError } from '../api/client';
import { useAcademy } from '../context/AcademyContext';
import { colors, radii, spacing } from '../theme';

export function ProfileScreen() {
  const { user, login, logout } = useAcademy();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [showOtp, setShowOtp] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleLogin() {
    setSubmitting(true);
    try {
      await login(email, password, showOtp ? otp : undefined);
      setPassword('');
      setOtp('');
    } catch (error) {
      Alert.alert('Sign in unsuccessful', readableError(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    setSubmitting(true);
    try {
      await logout();
    } finally {
      setSubmitting(false);
    }
  }

  if (user) {
    return (
      <Screen eyebrow="Account" title={user.full_name || 'Student profile'} description="Your academy identity and security controls.">
        <View style={styles.profileCard}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{(user.full_name || user.email).slice(0, 1).toUpperCase()}</Text></View>
          <Text style={styles.profileName}>{user.full_name || 'Academy student'}</Text>
          <Text style={styles.profileEmail}>{user.email}</Text>
          <View style={styles.rule} />
          <ProfileRow label="Role" value={user.role || 'Student'} />
          <ProfileRow label="Two-factor authentication" value={user.two_factor_enabled ? 'Enabled' : 'Not enabled'} />
        </View>
        <View style={styles.logout}><ActionButton label="Sign out securely" tone="dark" loading={submitting} onPress={() => void handleLogout()} /></View>
      </Screen>
    );
  }

  return (
    <Screen eyebrow="Controlled login" title="Welcome back" description="Use the username and password issued by the academy administrator.">
      <View style={styles.form}>
        <Field label="Email / username" value={email} onChangeText={setEmail} placeholder="adl###@alsyedinitiative.com" autoCapitalize="none" keyboardType="email-address" />
        <Field label="Password" value={password} onChangeText={setPassword} placeholder="Enter your password" secureTextEntry />
        <View style={styles.otpToggle}>
          <View style={styles.otpText}>
            <Text style={styles.label}>Authenticator code</Text>
            <Text style={styles.hint}>Enable this only if 2FA is active on your account.</Text>
          </View>
          <Switch value={showOtp} onValueChange={setShowOtp} trackColor={{ false: colors.border, true: '#5A5A5A' }} thumbColor={colors.white} />
        </View>
        {showOtp ? <Field label="Six-digit code" value={otp} onChangeText={setOtp} placeholder="000000" keyboardType="number-pad" /> : null}
        <ActionButton label="Sign in" loading={submitting} disabled={!email.trim() || !password} onPress={() => void handleLogin()} />
        <Text style={styles.securityNote}>Accounts are created and course access is granted only by academy administrators.</Text>
      </View>
    </Screen>
  );
}

type FieldProps = React.ComponentProps<typeof TextInput> & { label: string };

function Field({ label, ...props }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.textMuted} style={styles.input} {...props} />
    </View>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.profileRow}><Text style={styles.profileLabel}>{label}</Text><Text style={styles.profileValue}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  form: { backgroundColor: colors.panel, borderColor: colors.border, borderRadius: radii.lg, borderWidth: 1, gap: 18, marginTop: 28, padding: spacing.lg },
  field: { gap: 8 },
  label: { color: colors.textSoft, fontSize: 11, fontWeight: '900', letterSpacing: 1.2, textTransform: 'uppercase' },
  input: { backgroundColor: colors.card, borderColor: colors.border, borderRadius: radii.sm, borderWidth: 1, color: colors.text, fontSize: 15, minHeight: 54, paddingHorizontal: 15 },
  otpToggle: { alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  otpText: { flex: 1 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 5 },
  securityNote: { color: colors.textMuted, fontSize: 12, lineHeight: 19, textAlign: 'center' },
  profileCard: { alignItems: 'center', backgroundColor: colors.panel, borderColor: colors.border, borderRadius: radii.lg, borderWidth: 1, marginTop: 28, padding: spacing.lg },
  avatar: { alignItems: 'center', backgroundColor: colors.white, borderRadius: 34, height: 68, justifyContent: 'center', width: 68 },
  avatarText: { color: colors.black, fontSize: 25, fontWeight: '900' },
  profileName: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 16 },
  profileEmail: { color: colors.textMuted, fontSize: 13, marginTop: 5 },
  rule: { backgroundColor: colors.border, height: 1, marginVertical: 22, width: '100%' },
  profileRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, width: '100%' },
  profileLabel: { color: colors.textMuted, flex: 1, fontSize: 13 },
  profileValue: { color: colors.text, fontSize: 13, fontWeight: '800' },
  logout: { marginTop: 14 },
});
