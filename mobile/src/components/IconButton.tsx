import type { ComponentType } from "react";
import { Pressable, StyleSheet, type PressableProps } from "react-native";
import { useTheme } from "@/lib/theme";

type Icon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

/**
 * A round button that is only an icon. `plain` shows the icon on nothing
 * and a soft fill while pressed; `overlay` sits on a picture, in the camera
 * and the photo viewer. A disabled button fades.
 */
export function IconButton({
  icon: Icon,
  label,
  onPress,
  size = 36,
  iconSize = 20,
  variant = "plain",
  color,
  ...props
}: {
  icon: Icon;
  label: string;
  onPress(): void;
  size?: number;
  iconSize?: number;
  variant?: "plain" | "overlay";
  color?: string;
} & Pick<PressableProps, "hitSlop" | "disabled">) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      hitSlop={6}
      {...props}
      style={({ pressed }) => [
        styles.button,
        { width: size, height: size, borderRadius: size / 2 },
        variant === "overlay"
          ? { backgroundColor: theme.viewerControl, opacity: props.disabled ? 0.5 : pressed ? 0.6 : 1 }
          : { backgroundColor: pressed ? theme.field : "transparent", opacity: props.disabled ? 0.35 : 1 },
      ]}>
      <Icon size={iconSize} strokeWidth={2} color={color ?? (variant === "overlay" ? theme.viewerInk : theme.ink)} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: "center", justifyContent: "center" },
});
