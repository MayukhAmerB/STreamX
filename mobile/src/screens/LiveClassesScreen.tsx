import { Alert, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';

import { ActionButton } from '../components/ActionButton';
import { Screen } from '../components/Screen';
import { StateMessage } from '../components/StateMessage';
import { readableError } from '../api/client';
import { useAcademy } from '../context/AcademyContext';
import { colors, radii, spacing } from '../theme';
import type { LiveClass } from '../types';

export function LiveClassesScreen() {
  const navigation = useNavigation<any>();
  const { user, liveClasses, requestLiveAccess } = useAcademy();
  const [submitting, setSubmitting] = useState<number | null>(null);
  const currentlyLive = liveClasses.filter((item) => item.is_live);

  async function handleRequest(item: LiveClass) {
    if (!user) {
      navigation.navigate('Profile');
      return;
    }
    setSubmitting(item.id);
    try {
      Alert.alert('Access request', await requestLiveAccess(item.id));
    } catch (error) {
      Alert.alert('Request not sent', readableError(error));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Screen eyebrow="Instructor-led" title="Live classes" description="Scheduled every Friday, Saturday and Sunday from 7:00 to 8:00 PM IST.">
      <View style={[styles.stage, currentlyLive.length > 0 && styles.stageLive]}>
        <View style={styles.stageBadge}>
          <View style={[styles.stageDot, currentlyLive.length > 0 && styles.stageDotLive]} />
          <Text style={styles.stageBadgeText}>{currentlyLive.length > 0 ? 'Live now' : 'Next session'}</Text>
        </View>
        <Text style={styles.stageTitle}>{currentlyLive[0]?.title || 'Your classroom opens on schedule'}</Text>
        <Text style={styles.stageCopy}>{currentlyLive.length > 0 ? 'Your approved session is ready to join.' : 'The player will appear here automatically when an instructor starts the class.'}</Text>
        <View style={styles.timeBlock}>
          <Text style={styles.time}>7:00 PM</Text>
          <Text style={styles.timezone}>IST · FRI / SAT / SUN</Text>
        </View>
        {currentlyLive.length > 0 ? <ActionButton label="Join live class" tone="live" onPress={() => Alert.alert('Live classroom', 'Native LiveKit playback is the next implementation milestone.')} /> : null}
      </View>

      <Text style={styles.sectionLabel}>Available programs</Text>
      <View style={styles.list}>
        {liveClasses.length ? liveClasses.map((item) => {
          const approved = item.is_enrolled || item.enrollment_status === 'approved';
          const pending = item.enrollment_status === 'pending';
          return (
            <View key={item.id} style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.level}>{item.level || 'Live program'}</Text>
                <Text style={[styles.access, approved && styles.accessApproved]}>{approved ? 'Approved' : pending ? 'Pending' : 'Request access'}</Text>
              </View>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardCopy}>{item.description || 'Instructor-led practical training with controlled enrollment.'}</Text>
              <ActionButton
                label={item.is_live && approved ? 'Join live' : approved ? 'View schedule' : pending ? 'Request pending' : user ? 'Request access' : 'Sign in to request'}
                loading={submitting === item.id}
                disabled={pending}
                tone={item.is_live && approved ? 'live' : approved ? 'light' : 'dark'}
                onPress={() => approved ? Alert.alert('Class schedule', 'Friday, Saturday and Sunday · 7:00-8:00 PM IST') : void handleRequest(item)}
              />
            </View>
          );
        }) : <StateMessage title="No active live programs" body="Pull down to refresh the schedule from the academy server." />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stage: { backgroundColor: colors.panel, borderColor: colors.border, borderRadius: radii.lg, borderWidth: 1, marginTop: 26, overflow: 'hidden', padding: spacing.lg },
  stageLive: { borderColor: colors.live },
  stageBadge: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  stageDot: { backgroundColor: colors.textMuted, borderRadius: 5, height: 8, width: 8 },
  stageDotLive: { backgroundColor: colors.live },
  stageBadgeText: { color: colors.textSoft, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, textTransform: 'uppercase' },
  stageTitle: { color: colors.text, fontSize: 24, fontWeight: '900', lineHeight: 30, marginTop: 24 },
  stageCopy: { color: colors.textMuted, fontSize: 14, lineHeight: 21, marginTop: 10 },
  timeBlock: { borderBottomColor: colors.borderSoft, borderBottomWidth: 1, borderTopColor: colors.borderSoft, borderTopWidth: 1, marginVertical: 24, paddingVertical: 18 },
  time: { color: colors.text, fontSize: 36, fontWeight: '900', letterSpacing: -1.4 },
  timezone: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginTop: 5 },
  sectionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1.7, marginBottom: 12, marginTop: 28, textTransform: 'uppercase' },
  list: { gap: 12 },
  card: { backgroundColor: colors.card, borderColor: colors.borderSoft, borderRadius: radii.md, borderWidth: 1, gap: 16, padding: spacing.lg },
  cardTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  level: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, textTransform: 'uppercase' },
  access: { color: colors.warning, fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  accessApproved: { color: colors.success },
  cardTitle: { color: colors.text, fontSize: 19, fontWeight: '900', lineHeight: 25 },
  cardCopy: { color: colors.textMuted, fontSize: 14, lineHeight: 21 },
});
