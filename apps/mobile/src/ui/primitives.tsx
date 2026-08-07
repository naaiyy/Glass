import type { IconSvgElement } from "@hugeicons/react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type TextInputProps } from "react-native";

import { cn } from "./cn.ts";

export const StateCard = ({
  children,
  title,
}: Readonly<{ children: ReactNode; title: string }>) => (
  <View className="mt-4 gap-2 rounded-xl border border-border bg-card p-4">
    <Text className="text-base font-semibold text-card-foreground">{title}</Text>
    {children}
  </View>
);

export const ActionButton = ({
  disabled = false,
  icon,
  label,
  onPress,
}: Readonly<{
  disabled?: boolean;
  icon?: IconSvgElement;
  label: string;
  onPress: () => void;
}>) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    className={cn(
      "mt-3 min-h-11 flex-row items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 active:opacity-80",
      disabled && "opacity-50",
    )}
  >
    {icon === undefined ? null : (
      <HugeiconsIcon color="currentColor" icon={icon} size={18} strokeWidth={2} />
    )}
    <Text className="text-sm font-semibold text-primary-foreground">{label}</Text>
  </Pressable>
);

export const AppInput = ({ className, ...props }: TextInputProps & { className?: string }) => (
  <TextInput
    className={cn(
      "mt-3 min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-[15px] text-foreground",
      className,
    )}
    placeholderTextColor="#71717a"
    {...props}
  />
);

export const DetailLayout = ({
  children,
  title,
}: Readonly<{ children: ReactNode; title: string }>) => (
  <ScrollView
    className="flex-1 bg-background"
    contentContainerClassName="flex-grow px-5 pb-16 pt-6"
  >
    <Text className="text-xs font-semibold tracking-widest text-muted-foreground">GLASS CLOUD</Text>
    <Text className="mb-5 mt-2 text-3xl font-semibold tracking-tight text-foreground">{title}</Text>
    {children}
  </ScrollView>
);
