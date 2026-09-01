import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BrandMark } from '../components/BrandMark';
import { Screen } from '../components/Screen';
import { StateMessage } from '../components/StateMessage';
import { useAcademy } from '../context/AcademyContext';
import { colors, radii, spacing } from '../theme';

export function HomeScreen() {
  const navigation = useNavigation<any>();
  const { user, courses, myCourses, liveClasses, error } = useAcademy();
  const approvedLive = liveClasses.filter((item) => item.is_enrolled || item.enrollment_status === 'approved');

  return (
    <Screen
      eyebrow={user ? 'Your workspace' : 'Academy mobile'}
      title={user ? `Welcome back, ${user.full_name?.split(' ')[0] || 'student'}` : 'Practical skills. Clear direction.'}
      description={user ? 'Everything approved for your account is ready here.' : 'Explore the live academy catalog, then sign in with your admin-issued credentials.'}
      action={<BrandMark />}
    >
      <View style={styles.workspace}>
        <View style={styles.workspaceTop}>
          <View style={styles.statusLine}>
            <View style={[styles.statusDot, !user && styles.statusDotGuest]} />
            <Text style={styles.statusText}>{user ? 'Account active' : 'Guest preview'}</Text>
          </View>
          <Text style={styles.workspaceTitle}>{user ? 'Your approved learning' : 'Current academy catalog'}</Text>
          <Text style={styles.workspaceCopy}>
            {user
              ? `${myCourses.length} courses and ${approvedLive.length} live classes available.`
              : `${courses.length} published courses and ${liveClasses.length} live programs available.`}
          </Text>
        </View>

        <View style={styles.grid}>
          <DashboardTile
            label={user ? 'My courses' : 'Courses'}
            value={user ? myCourses.length : courses.length}
            detail={user ? myCourses[0]?.title || 'No approved courses yet.' : courses[0]?.title || 'Catalog loading'}
            onPress={() => navigation.navigate('Courses')}
          />
          <DashboardTile
            label="Live classes"
            value={user ? approvedLive.length : liveClasses.length}
            detail={approvedLive[0]?.title || liveClasses[0]?.title || 'Friday to Sunday, 7-8 PM IST'}
            onPress={() => navigation.navigate('Live')}
          />
        </View>
      </View>

      {error ? <View style={styles.message}><StateMessage title="Connection notice" body={error} /></View> : null}

      <Text style={styles.sectionLabel}>Start here</Text>
      <Pressable style={styles.primaryRoute} onPress={() => navigation.navigate(user ? 'Courses' : 'Profile')}>
        <View>
          <Text style={styles.routeEyebrow}>{user ? 'Continue learning' : 'Controlled access'}</Text>
          <Text style={styles.routeTitle}>{user ? 'Open your learning library' : 'Sign in with issued credentials'}</Text>
        </View>
        <Ionicons name="arrow-forward" color={colors.black} size={20} />
      </Pressable>
    </Screen>
  );
}

function DashboardTile({ label, value, detail, onPress }: { label: string; value: number; detail: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}>
      <View style={styles.tileTop}>
        <Text style={styles.tileLabel}>{label}</Text>
        <Text style={styles.tileValue}>{String(value).padStart(2, '0')}</Text>
      </View>
      <Text numberOfLines={2} style={styles.tileDetail}>{detail}</Text>
      <View style={styles.tileAction}>
        <Text style={styles.tileActionText}>Open</Text>
        <Ionicons name="arrow-forward" color={colors.textSoft} size={16} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  workspace: { backgroundColor: colors.panel, borderColor: colors.border, borderRadius: radii.lg, borderWidth: 1, marginTop: 28, padding: 12 },
  workspaceTop: { backgroundColor: colors.card, borderRadius: radii.md, padding: spacing.lg },
  statusLine: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  statusDot: { backgroundColor: colors.success, borderRadius: 5, height: 8, width: 8 },
  statusDotGuest: { backgroundColor: colors.warning },
  statusText: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, textTransform: 'uppercase' },
  workspaceTitle: { color: colors.text, fontSize: 22, fontWeight: '900', marginTop: 20 },
  workspaceCopy: { color: colors.textMuted, fontSize: 14, lineHeight: 21, marginTop: 7 },
  grid: { gap: 10, marginTop: 10 },
  tile: { backgroundColor: colors.card, borderColor: colors.borderSoft, borderRadius: radii.md, borderWidth: 1, minHeight: 150, padding: 18 },
  tilePressed: { backgroundColor: '#121212', borderColor: '#4A4A4A' },
  tileTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  tileLabel: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: 1.1, textTransform: 'uppercase' },
  tileValue: { color: colors.textSoft, fontSize: 16, fontWeight: '900' },
  tileDetail: { color: colors.textMuted, fontSize: 13, lineHeight: 20, marginTop: 18 },
  tileAction: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 'auto', paddingTop: 18 },
  tileActionText: { color: colors.textSoft, fontSize: 11, fontWeight: '900', letterSpacing: 1.3, textTransform: 'uppercase' },
  message: { marginTop: 16 },
  sectionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 1.8, marginBottom: 12, marginTop: 28, textTransform: 'uppercase' },
  primaryRoute: { alignItems: 'center', backgroundColor: colors.white, borderRadius: radii.md, flexDirection: 'row', justifyContent: 'space-between', minHeight: 92, padding: 20 },
  routeEyebrow: { color: '#626262', fontSize: 10, fontWeight: '900', letterSpacing: 1.4, textTransform: 'uppercase' },
  routeTitle: { color: colors.black, fontSize: 17, fontWeight: '900', marginTop: 7 },
});
