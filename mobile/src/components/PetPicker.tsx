import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import type { Pet } from "@server/contract";
import { PetView } from "@/components/PetView";
import { EASE } from "@/lib/motion";
import { usePets } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/** The pets on the server as tiles, with the chosen one outlined. The outline fades from one tile to the next. */
export function PetPicker({ value, onChange }: { value: string | undefined; onChange: (petId: string) => void }) {
  const pets = usePets();
  return (
    <View style={styles.pets}>
      {pets.map((pet) => (
        <PetTile key={pet.id} pet={pet} chosen={pet.id === value} onPress={() => onChange(pet.id)} />
      ))}
    </View>
  );
}

function PetTile({ pet, chosen, onPress }: { pet: Pet; chosen: boolean; onPress: () => void }) {
  const theme = useTheme();
  const outline = useAnimatedStyle(() => ({ opacity: withTiming(chosen ? 1 : 0, EASE) }));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={pet.displayName}
      accessibilityState={{ selected: chosen }}
      style={[styles.pet, { backgroundColor: theme.field }]}>
      <PetView petId={pet.id} state="resting" size={48} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.outline, { borderColor: theme.tintInk }, outline]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pets: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  pet: { width: 72, height: 76, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  outline: { borderRadius: 16, borderWidth: 2 },
});
