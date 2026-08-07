import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { styles } from "./styles.ts";

export const StateCard = ({
  children,
  title,
}: Readonly<{ children: ReactNode; title: string }>) => (
  <View style={styles.stateCard}>
    <Text style={styles.stateTitle}>{title}</Text>
    {children}
  </View>
);

export const ActionButton = ({
  disabled = false,
  label,
  onPress,
}: Readonly<{
  disabled?: boolean;
  label: string;
  onPress: () => void;
}>) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={[styles.button, disabled && styles.buttonDisabled]}
  >
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>
);

export const DetailLayout = ({
  children,
  title,
}: Readonly<{ children: ReactNode; title: string }>) => (
  <ScrollView contentContainerStyle={styles.screen}>
    <Text style={styles.eyebrow}>GLASS CLOUD</Text>
    <Text style={styles.detailTitle}>{title}</Text>
    {children}
  </ScrollView>
);
