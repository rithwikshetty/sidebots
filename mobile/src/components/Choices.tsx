import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "@/lib/theme";

/** A row of choices where one is in effect, as for an agent's model or effort. */
export function Choices<Id extends string>({ options, value, onChange }: { options: Record<Id, string>; value: Id; onChange: (value: Id) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.choices}>
      {(Object.keys(options) as Id[]).map((id) => (
        <Pressable
          key={id}
          onPress={() => onChange(id)}
          accessibilityRole="button"
          accessibilityState={{ selected: id === value }}
          style={[styles.choice, id === value && { backgroundColor: theme.tint }]}>
          <Text style={[styles.choiceText, { color: id === value ? theme.onTint : theme.ink }]}>{options[id]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: "row", padding: 4, gap: 4 },
  choice: { flex: 1, height: 38, borderRadius: 12, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  choiceText: { fontSize: 15, fontWeight: "600" },
});
