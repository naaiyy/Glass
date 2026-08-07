import type { IconSvgElement } from "@hugeicons/react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Loading03Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { useCSSVariable } from "uniwind";

import { cn } from "./cn.ts";

export const CenteredLoadingState = ({ label }: Readonly<{ label: string }>) => {
  const rotation = useRef(new Animated.Value(0)).current;
  const resolvedMutedForeground = useCSSVariable("--color-muted-foreground");
  const iconColor =
    typeof resolvedMutedForeground === "string" ? resolvedMutedForeground : "#71717a";

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(rotation, {
        duration: 1_000,
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [rotation]);

  return (
    <View className="flex-1 items-center justify-center gap-2 bg-background px-5">
      <Animated.View
        style={{
          transform: [
            {
              rotate: rotation.interpolate({
                inputRange: [0, 1],
                outputRange: ["0deg", "360deg"],
              }),
            },
          ],
        }}
      >
        <HugeiconsIcon
          accessibilityLabel="Loading"
          color={iconColor}
          icon={Loading03Icon}
          size={16}
          strokeWidth={2}
        />
      </Animated.View>
      <Text className="text-sm text-muted-foreground">{label}</Text>
    </View>
  );
};

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
}>) => {
  const resolvedForeground = useCSSVariable("--color-primary-foreground");
  const iconColor = typeof resolvedForeground === "string" ? resolvedForeground : undefined;

  return (
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
        <HugeiconsIcon color={iconColor} icon={icon} size={18} strokeWidth={2} />
      )}
      <Text className="text-sm font-semibold text-primary-foreground">{label}</Text>
    </Pressable>
  );
};

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

export const SelectMenu = <Value extends string>({
  disabled = false,
  label,
  onSelect,
  options,
  placeholder = "Choose an option",
  value,
}: Readonly<{
  disabled?: boolean;
  label: string;
  onSelect: (value: Value) => void;
  options: readonly Readonly<{ label: string; value: Value }>[];
  placeholder?: string;
  value: Value | null;
}>) => {
  const [open, setOpen] = useState(false);
  const resolvedForeground = useCSSVariable("--color-foreground");
  const iconColor = typeof resolvedForeground === "string" ? resolvedForeground : undefined;
  const selected = options.find((option) => option.value === value);

  return (
    <View className="mt-3 gap-2">
      <Text className="text-sm font-semibold text-foreground">{label}</Text>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: open }}
        className={cn(
          "min-h-11 flex-row items-center justify-between rounded-lg border border-input bg-background px-3 py-2",
          disabled && "opacity-50",
        )}
        disabled={disabled}
        onPress={() => setOpen(true)}
      >
        <Text className={selected === undefined ? "text-muted-foreground" : "text-foreground"}>
          {selected?.label ?? placeholder}
        </Text>
        <HugeiconsIcon color={iconColor} icon={UnfoldMoreIcon} size={18} strokeWidth={2} />
      </Pressable>
      <Modal animationType="fade" onRequestClose={() => setOpen(false)} transparent visible={open}>
        <View className="flex-1 justify-center px-5">
          <Pressable
            accessibilityLabel={`Close ${label} menu`}
            accessibilityRole="button"
            className="absolute inset-0 bg-black/40"
            onPress={() => setOpen(false)}
          />
          <View className="max-h-[70%] gap-2 rounded-xl border border-border bg-card p-3">
            <Text className="px-2 py-1 text-base font-semibold text-card-foreground">{label}</Text>
            <ScrollView>
              {options.map((option) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: option.value === value }}
                  className={cn(
                    "min-h-11 flex-row items-center justify-between rounded-lg px-3 py-2",
                    option.value === value && "bg-muted",
                  )}
                  key={option.value}
                  onPress={() => {
                    onSelect(option.value);
                    setOpen(false);
                  }}
                >
                  <Text className="text-[15px] text-card-foreground">{option.label}</Text>
                  {option.value === value ? (
                    <Text className="text-xs font-semibold text-muted-foreground">Selected</Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
            <ActionButton label="Cancel" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
};

export const DetailLayout = ({
  children,
  title,
}: Readonly<{ children: ReactNode; title: string }>) => (
  <ScrollView
    className="flex-1 bg-background"
    contentContainerClassName="flex-grow px-5 pb-16 pt-6"
    contentInsetAdjustmentBehavior="automatic"
  >
    <Text className="text-xs font-semibold tracking-widest text-muted-foreground">GLASS CLOUD</Text>
    <Text className="mb-5 mt-2 text-3xl font-semibold tracking-tight text-foreground">{title}</Text>
    {children}
  </ScrollView>
);
