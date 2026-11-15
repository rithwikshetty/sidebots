import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import type { Avatar } from "@server/contract";
import { AvatarView } from "@/components/AvatarView";
import { EASE } from "@/lib/motion";
import { useAvatars } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/** The avatars on the server as tiles, with the chosen one outlined. The outline fades from one tile to the next. */
export function AvatarPicker({ value, onChange }: { value: string | undefined; onChange: (avatarId: string) => void }) {
  const avatars = useAvatars();
  return (
    <View style={styles.avatars}>
      {avatars.map((avatar) => (
        <AvatarTile key={avatar.id} avatar={avatar} chosen={avatar.id === value} onPress={() => onChange(avatar.id)} />
      ))}
    </View>
  );
}

function AvatarTile({ avatar, chosen, onPress }: { avatar: Avatar; chosen: boolean; onPress: () => void }) {
  const theme = useTheme();
  const outline = useAnimatedStyle(() => ({ opacity: withTiming(chosen ? 1 : 0, EASE) }));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={avatar.displayName}
      accessibilityState={{ selected: chosen }}
      style={[styles.avatar, { backgroundColor: theme.field }]}>
      <AvatarView avatarId={avatar.id} state="resting" size={48} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.outline, { borderColor: theme.tintInk }, outline]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  avatars: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  avatar: { width: 72, height: 76, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  outline: { borderRadius: 16, borderWidth: 2 },
});
