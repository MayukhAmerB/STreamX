import type { PropsWithChildren, ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAcademy } from '../context/AcademyContext';
import { colors, spacing } from '../theme';

type ScreenProps = PropsWithChildren<{
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}>;

export function Screen({ eyebrow, title, description, action, children }: ScreenProps) {
  const { loading, refresh } = useAcademy();
  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.text} />}
      >
        <View style={styles.headerRow}>
          <View style={styles.heading}>
            {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
            <Text style={styles.title}>{title}</Text>
            {description ? <Text style={styles.description}>{description}</Text> : null}
          </View>
          {action}
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: colors.background, flex: 1 },
  content: { paddingBottom: 42, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  headerRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  heading: { flex: 1 },
  eyebrow: { color: colors.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 2.2, marginBottom: 10, textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -1.2 },
  description: { color: colors.textMuted, fontSize: 15, lineHeight: 23, marginTop: 10, maxWidth: 420 },
});
