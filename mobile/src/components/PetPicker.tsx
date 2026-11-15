import { Pressable, StyleSheet, View } from "react-native";
import { PetView } from "@/components/PetView";
import { usePets } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/** The pets on the server as tiles, with the chosen one outlined. */
export function PetPicker({ value, onChange }: { value: string | undefined; onChange: (petId: string) => void }) {
  const theme = useTheme();
  const pets = usePets();
  return (
    <View style={styles.pets}>
      {pets.map((pet) => (
        <Pressable
          key={pet.id}
          onPress={() => onChange(pet.id)}
          accessibilityRole="button"
          accessibilityLabel={pet.displayName}
          accessibilityState={{ selected: pet.id === value }}
          style={[styles.pet, { borderColor: pet.id === value ? theme.tintInk : "transparent", backgroundColor: theme.field }]}>
          <PetView petId={pet.id} state="resting" size={48} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pets: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  pet: { width: 72, height: 76, borderRadius: 16, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
