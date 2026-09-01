import { Ionicons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AcademyProvider, useAcademy } from './src/context/AcademyContext';
import { colors } from './src/theme';
import { CoursesScreen } from './src/screens/CoursesScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { LiveClassesScreen } from './src/screens/LiveClassesScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';

type TabParamList = {
  Home: undefined;
  Courses: undefined;
  Live: undefined;
  Profile: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

const icons: Record<keyof TabParamList, keyof typeof Ionicons.glyphMap> = {
  Home: 'grid-outline',
  Courses: 'play-circle-outline',
  Live: 'radio-outline',
  Profile: 'person-circle-outline',
};

function AppNavigator() {
  const { booting } = useAcademy();

  if (booting) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.text} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={{ ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.background } }}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.text,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: styles.tabBar,
          tabBarLabelStyle: styles.tabLabel,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name={icons[route.name]} color={color} size={size} />
          ),
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
        <Tab.Screen name="Courses" component={CoursesScreen} />
        <Tab.Screen name="Live" component={LiveClassesScreen} />
        <Tab.Screen name="Profile" component={ProfileScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AcademyProvider>
        <StatusBar style="light" />
        <AppNavigator />
      </AcademyProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
  tabBar: {
    backgroundColor: '#090909',
    borderTopColor: colors.border,
    height: 72,
    paddingBottom: 10,
    paddingTop: 8,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});
