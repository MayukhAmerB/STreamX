import { StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '../theme';

export function StateMessage({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderColor: colors.borderSoft, borderRadius: radii.md, borderWidth: 1, padding: spacing.lg },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 21, marginTop: 7 },
});
