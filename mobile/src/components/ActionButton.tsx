import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { colors, radii } from '../theme';

type ActionButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'light' | 'dark' | 'live';
};

export function ActionButton({ label, onPress, disabled, loading, tone = 'light' }: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [styles.base, styles[tone], pressed && styles.pressed, (disabled || loading) && styles.disabled]}
    >
      {loading ? <ActivityIndicator color={tone === 'light' ? colors.black : colors.white} /> : <Text style={[styles.label, tone === 'light' && styles.labelDark]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', borderRadius: radii.sm, justifyContent: 'center', minHeight: 50, paddingHorizontal: 18 },
  light: { backgroundColor: colors.white },
  dark: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 },
  live: { backgroundColor: colors.live },
  label: { color: colors.white, fontSize: 13, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' },
  labelDark: { color: colors.black },
  pressed: { opacity: 0.76, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.45 },
});
