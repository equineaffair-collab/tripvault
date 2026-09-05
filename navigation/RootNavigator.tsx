import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useAuth } from '../contexts/AuthContext';
import AuthScreen from '../screens/AuthScreen';
import ProfileScreen from '../screens/ProfileScreen';
import DocumentsScreen from '../screens/DocumentsScreen';
import TripsScreen from '../screens/TripsScreen';

const Tab = createBottomTabNavigator();

export default function RootNavigator() {
  const { session, initializing } = useAuth();

  if (initializing) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {session ? (
        <Tab.Navigator
          screenOptions={{
            tabBarActiveTintColor: '#1B6EF3',
            // Label-only tabs. Without an explicit icon the navigator renders a
            // placeholder glyph, which Android draws as an empty box. Real icons
            // need @expo/vector-icons, which is not a dependency yet.
            tabBarIcon: () => null,
            tabBarLabelStyle: { fontSize: 13, fontWeight: '500' },
            // No tabBarStyle override. The navigator already sizes the bar
            // around the gesture inset; setting an explicit height replaces
            // that calculation rather than adding to it, which pushed the
            // labels underneath Android's gesture handle.
          }}
        >
          <Tab.Screen name="Documents" component={DocumentsScreen} />
          <Tab.Screen name="Trips" component={TripsScreen} />
          <Tab.Screen name="Profile" component={ProfileScreen} />
        </Tab.Navigator>
      ) : (
        <AuthScreen />
      )}
    </NavigationContainer>
  );
}
