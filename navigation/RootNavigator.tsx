import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useAuth } from '../contexts/AuthContext';
import { getLinkedIdentity, type LinkedIdentity } from '../lib/familyAccess';
import AuthScreen from '../screens/AuthScreen';
import ProfileScreen from '../screens/ProfileScreen';
import DocumentsScreen from '../screens/DocumentsScreen';
import TripsScreen from '../screens/TripsScreen';
import LinkedTripsScreen from '../screens/linked/LinkedTripsScreen';
import LinkedDocumentsScreen from '../screens/linked/LinkedDocumentsScreen';

const Tab = createBottomTabNavigator();

const tabOptions = {
  tabBarActiveTintColor: '#1B6EF3',
  // Label-only tabs. Without an explicit icon the navigator renders a
  // placeholder glyph, which Android draws as an empty box. Real icons
  // need @expo/vector-icons, which is not a dependency yet.
  tabBarIcon: () => null,
  tabBarLabelStyle: { fontSize: 13, fontWeight: '500' as const },
  // No tabBarStyle override. The navigator already sizes the bar around the
  // gesture inset; setting an explicit height replaces that calculation rather
  // than adding to it, which pushed the labels underneath Android's gesture
  // handle.
};

function Spinner() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" />
    </View>
  );
}

export default function RootNavigator() {
  const { session, initializing } = useAuth();

  // F9: a linked family member gets a different app, not the same app with
  // buttons hidden. Deciding it here means no screen below has to ask "am I
  // allowed to do this" — the read-only experience simply has no way in.
  const [linked, setLinked] = useState<LinkedIdentity | null>(null);
  const [resolving, setResolving] = useState(true);

  const resolveRole = useCallback(async () => {
    if (!session) {
      setLinked(null);
      setResolving(false);
      return;
    }
    setResolving(true);
    setLinked(await getLinkedIdentity());
    setResolving(false);
  }, [session]);

  useEffect(() => {
    void resolveRole();
  }, [resolveRole]);

  if (initializing || (session && resolving)) return <Spinner />;

  if (!session) {
    return (
      <NavigationContainer>
        <AuthScreen />
      </NavigationContainer>
    );
  }

  if (linked) {
    return (
      <NavigationContainer>
        <Tab.Navigator screenOptions={tabOptions}>
          <Tab.Screen name="Your trips" component={LinkedTripsScreen} />
          <Tab.Screen name="Your documents" component={LinkedDocumentsScreen} />
        </Tab.Navigator>
      </NavigationContainer>
    );
  }

  return (
    <NavigationContainer>
      <Tab.Navigator screenOptions={tabOptions}>
        <Tab.Screen name="Documents" component={DocumentsScreen} />
        <Tab.Screen name="Trips" component={TripsScreen} />
        <Tab.Screen name="Profile">
          {/* Accepting an invite changes which app this account gets, so the
              Profile screen needs a way to say "re-check who I am" rather than
              waiting for a restart. */}
          {() => <ProfileScreen onRoleMayHaveChanged={resolveRole} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}
