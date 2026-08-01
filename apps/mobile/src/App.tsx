import { initialConnectionState } from "@glass/client-runtime/connections";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

type RootStack = {
  Foundation: undefined;
};

const Stack = createNativeStackNavigator<RootStack>();

const FoundationScreen = () => {
  const connections = initialConnectionState();

  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>GLASS · MOBILE</Text>
      <Text style={styles.title}>Product available. Execution optional.</Text>
      <View style={styles.status}>
        <Text style={styles.body}>Product: {connections.product.status}</Text>
        <Text style={styles.body}>Execution: {connections.execution.status}</Text>
      </View>
      <StatusBar />
    </View>
  );
};

export const App = () => (
  <NavigationContainer>
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen component={FoundationScreen} name="Foundation" />
    </Stack.Navigator>
  </NavigationContainer>
);

const styles = StyleSheet.create({
  body: { color: "#aebbb6", fontSize: 17, lineHeight: 28 },
  eyebrow: { color: "#8de0bd", fontSize: 12, fontWeight: "700", letterSpacing: 2 },
  screen: { backgroundColor: "#101617", flex: 1, justifyContent: "center", padding: 28 },
  title: {
    color: "#eaf0ed",
    fontSize: 48,
    fontWeight: "700",
    letterSpacing: -2,
    lineHeight: 50,
    marginTop: 16,
  },
  status: { marginTop: 24 },
});
