import { Image, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

export function BrandMark() {
  return (
    <View style={styles.row}>
      <Image source={require('../../assets/brand-logo.jpeg')} style={styles.logo} />
      <View>
        <Text style={styles.title}>Al syed Initiative</Text>
        <Text style={styles.subtitle}>Cybersecurity Platform</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', flexDirection: 'row', gap: 11 },
  logo: { borderRadius: 10, height: 42, width: 42 },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.6, marginTop: 3, textTransform: 'uppercase' },
});
