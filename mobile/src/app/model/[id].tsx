import { Fragment } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Check } from "lucide-react-native";
import { PROVIDERS, type AgentWithLatest, type Offered } from "@server/contract";
import { BrandLogo } from "@/components/BrandLogo";
import { Rule, Section } from "@/components/Section";
import { problem } from "@/lib/alerts";
import { changeAgent, useAgent, type AgentChanges } from "@/lib/state";
import { useTheme } from "@/lib/theme";

export default function ModelDrawer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgent(id);
  return agent ? <Model agent={agent} /> : null;
}

/**
 * The drawer the model's button in the message field opens: the provider's
 * logo and name, then its models and how hard the agent can think before it
 * answers, a row to each, with a check by the one of each in effect. A tap
 * on another takes effect from the agent's next turn, and the drawer stays up
 * for the other choice until it is swiped away.
 */
function Model({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const provider: Offered = PROVIDERS[agent.provider];
  const change = (changes: AgentChanges) => void changeAgent(agent.id, changes).catch((failure) => problem("Couldn't change that", failure));
  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.page}>
      <View style={styles.provider}>
        <BrandLogo logo={provider.logo} size={22} />
        <Text accessibilityRole="header" style={[styles.name, { color: theme.ink }]}>
          {provider.name}
        </Text>
      </View>
      <Section title="Model">
        <Options options={provider.models} value={agent.model} onChange={(model) => change({ model })} />
      </Section>
      <Section
        title="Effort"
        note="How hard it thinks before it answers. A more capable model and more effort are slower, and use more of your plan or API credit. A model without the effort you pick runs at the highest it has.">
        <Options options={provider.efforts} value={agent.effort} onChange={(effort) => change({ effort })} />
      </Section>
    </ScrollView>
  );
}

/** A card's rows of choices where one is in effect, which wears the check. */
function Options<Id extends string>({ options, value, onChange }: { options: Partial<Record<Id, string>>; value: Id; onChange: (value: Id) => void }) {
  const theme = useTheme();
  return (Object.keys(options) as Id[]).map((id, index) => (
    <Fragment key={id}>
      {index ? <Rule /> : null}
      <Pressable
        onPress={() => onChange(id)}
        accessibilityRole="button"
        accessibilityState={{ selected: id === value }}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.line }]}>
        <Text style={[styles.rowTitle, { color: theme.ink }]}>{options[id]}</Text>
        {id === value ? <Check size={18} strokeWidth={2.5} color={theme.tintInk} /> : null}
      </Pressable>
    </Fragment>
  ));
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 32 },
  provider: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  name: { fontSize: 20, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 50 },
  rowTitle: { flex: 1, fontSize: 16, lineHeight: 21 },
});
