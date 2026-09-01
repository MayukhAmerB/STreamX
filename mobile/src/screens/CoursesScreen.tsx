import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { ActionButton } from '../components/ActionButton';
import { Screen } from '../components/Screen';
import { StateMessage } from '../components/StateMessage';
import { useAcademy } from '../context/AcademyContext';
import { readableError } from '../api/client';
import { colors, radii, spacing } from '../theme';
import type { Course } from '../types';

export function CoursesScreen() {
  const navigation = useNavigation<any>();
  const { user, courses, myCourses, requestCourseAccess } = useAcademy();
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState<number | null>(null);
  const source = user && myCourses.length ? [...myCourses, ...courses.filter((item) => !myCourses.some((mine) => mine.id === item.id))] : courses;
  const filtered = source.filter((course) => `${course.title} ${course.description || ''} ${course.level || ''}`.toLowerCase().includes(query.toLowerCase()));

  async function handleRequest(course: Course) {
    if (!user) {
      navigation.navigate('Profile');
      return;
    }
    setSubmitting(course.id);
    try {
      Alert.alert('Access request', await requestCourseAccess(course.id));
    } catch (error) {
      Alert.alert('Request not sent', readableError(error));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Screen eyebrow="Learning library" title="Courses" description="Browse published programs. Approved lessons appear automatically after admin access is granted.">
      <View style={styles.searchBox}>
        <Ionicons name="search" color={colors.textMuted} size={19} />
        <TextInput
          accessibilityLabel="Search courses"
          onChangeText={setQuery}
          placeholder="Search title, level or topic"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          value={query}
        />
      </View>

      <View style={styles.list}>
        {filtered.length ? filtered.map((course) => {
          const approved = myCourses.some((item) => item.id === course.id) || course.is_enrolled;
          const pending = course.enrollment_status === 'pending';
          return (
            <View key={course.id} style={styles.card}>
              <View style={styles.metaRow}>
                <Text style={styles.meta}>{course.level || course.category || 'Program'}</Text>
                <Text style={[styles.status, approved && styles.approved]}>{approved ? 'Approved' : pending ? 'Pending' : 'Available'}</Text>
              </View>
              <Text style={styles.title}>{course.title}</Text>
              <Text numberOfLines={3} style={styles.description}>{course.description || 'Structured practical training with controlled student access.'}</Text>
              <View style={styles.divider} />
              <ActionButton
                label={approved ? 'Continue course' : pending ? 'Request pending' : user ? 'Request access' : 'Sign in to request'}
                loading={submitting === course.id}
                disabled={pending}
                onPress={() => approved ? Alert.alert('Course player', 'The native lesson player is the next implementation milestone.') : void handleRequest(course)}
                tone={approved ? 'light' : 'dark'}
              />
            </View>
          );
        }) : <StateMessage title="No matching courses" body="Try a broader search or pull down to refresh the current catalog." />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchBox: { alignItems: 'center', backgroundColor: colors.card, borderColor: colors.border, borderRadius: radii.md, borderWidth: 1, flexDirection: 'row', gap: 10, marginTop: 26, paddingHorizontal: 16 },
  searchInput: { color: colors.text, flex: 1, fontSize: 15, minHeight: 54 },
  list: { gap: 12, marginTop: 16 },
  card: { backgroundColor: colors.panel, borderColor: colors.border, borderRadius: radii.lg, borderWidth: 1, padding: spacing.lg },
  metaRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  meta: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, textTransform: 'uppercase' },
  status: { color: colors.warning, fontSize: 10, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' },
  approved: { color: colors.success },
  title: { color: colors.text, fontSize: 21, fontWeight: '900', lineHeight: 27, marginTop: 18 },
  description: { color: colors.textMuted, fontSize: 14, lineHeight: 22, marginTop: 10 },
  divider: { backgroundColor: colors.borderSoft, height: 1, marginVertical: 20 },
});
