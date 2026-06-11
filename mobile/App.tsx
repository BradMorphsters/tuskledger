/**
 * Root component: decides PairingScreen vs. tab navigator based on
 * whether a device token is present, kicks off the sync engine, and
 * handles re-pair when the laptop revokes the token (status =
 * 'unauthed' triggers a return to the pairing flow).
 */
// MUST be the very first import (or near it). react-native-screens@4
// under Fabric/new-arch has a prop-type bug in its <Suspender> wrapper
// that throws "expected boolean got string" when React Navigation v7
// mounts a tab. Forcing native screens OFF makes React Navigation fall
// back to plain JS Views, sidesteps the bug. Trade-off is a small perf
// hit on tab switches — fine for v1, revisit when react-native-screens
// patches the issue upstream.
import { enableScreens } from 'react-native-screens';
enableScreens(false);

import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import TabIcon, { TabIconName } from './src/components/TabIcon';
import DashboardScreen from './src/screens/DashboardScreen';
import InvestmentsScreen from './src/screens/InvestmentsScreen';
import PairingScreen from './src/screens/PairingScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import TransactionsScreen from './src/screens/TransactionsScreen';
import { hydrateDemoMode } from './src/state/appStore';
import {
  startPeriodicSync,
  stopPeriodicSync,
  syncNow,
  useSyncStore,
} from './src/sync/manager';
import { rediscoverIfNeeded } from './src/sync/discover';
import { loadPairedHost, loadToken } from './src/sync/storage';
import { colors } from './src/theme';

const Tab = createBottomTabNavigator();

// React Navigation v7 themes require a `fonts` object in addition to
// `dark` + `colors`. Spreading from DarkTheme (rather than DefaultTheme +
// `dark: true`) inherits the fonts shape — passing a v6-shaped theme to
// v7 crashes deep inside the Animated screen wrapper with a confusing
// "expected boolean got string" error from Fabric.
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    border: colors.border,
    text: colors.text,
    primary: colors.accent,
    notification: colors.expense,
  },
};

export default function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const status = useSyncStore((s) => s.status);

  // 'unauthed' means the laptop revoked the token mid-session — bounce
  // back to pairing so the user can sort it out without restarting.
  useEffect(() => {
    if (status === 'unauthed') setPaired(false);
  }, [status]);

  // Initial pairing check + first sync. Also hydrates the demo-mode
  // flag into the app store once, so SyncBadge & co. never have to
  // poll SecureStore.
  useEffect(() => {
    (async () => {
      hydrateDemoMode();
      const [host, token] = await Promise.all([loadPairedHost(), loadToken()]);
      const isPaired = !!(host && token);
      setPaired(isPaired);
      if (isPaired) {
        // Don't await — let the UI render and let the sync surface
        // through the sync badge.
        syncNow();
        startPeriodicSync();
      }
    })();
    return () => stopPeriodicSync();
  }, []);

  // Foreground re-sync. iOS suspends RN timers when the app is
  // backgrounded; sync on return rather than relying on whatever
  // partial timer state survived.
  //
  // Rediscovery first: if the laptop's IP changed while we were away
  // (DHCP lease, network swap), the cached baseUrl is wrong. Bonjour
  // browse re-locates it before sync runs, so we don't show a phantom
  // "Offline" for what's actually a stale-IP problem.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s === 'active' && paired) {
        await rediscoverIfNeeded().catch(() => {});
        syncNow();
      }
    });
    return () => sub.remove();
  }, [paired]);

  const onPaired = useCallback(() => {
    setPaired(true);
    startPeriodicSync();
  }, []);

  const onUnpaired = useCallback(() => {
    stopPeriodicSync();
    setPaired(false);
  }, []);

  if (paired === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {!paired ? (
          <PairingScreen onPaired={onPaired} />
        ) : (
          <NavigationContainer theme={navTheme}>
            <Tab.Navigator
              screenOptions={({ route }) => ({
                headerShown: false,
                tabBarStyle: {
                  backgroundColor: colors.surface,
                  borderTopColor: colors.borderSubtle,
                },
                tabBarActiveTintColor: colors.accent,
                tabBarInactiveTintColor: colors.textFaint,
                tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
                tabBarIcon: ({ color }) => (
                  <TabIcon
                    name={route.name.toLowerCase() as TabIconName}
                    color={color}
                    size={22}
                  />
                ),
              })}>
              <Tab.Screen name="Dashboard" component={DashboardScreen} />
              <Tab.Screen name="Transactions" component={TransactionsScreen} />
              <Tab.Screen name="Investments" component={InvestmentsScreen} />
              <Tab.Screen name="Settings">
                {() => <SettingsScreen onUnpaired={onUnpaired} />}
              </Tab.Screen>
            </Tab.Navigator>
          </NavigationContainer>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
