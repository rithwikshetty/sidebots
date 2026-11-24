import { Fragment, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useLocalSearchParams } from "expo-router";
import { Check } from "lucide-react-native";
import { PROVIDERS, runsFast, type AgentWithLatest, type Offered, type Provider } from "@server/contract";
import { BrandLogo } from "@/components/BrandLogo";
import { Choices } from "@/components/Choices";
import { Rule, Section } from "@/components/Section";
import { problem } from "@/lib/alerts";
import { changeAgent, loadUsage, useAgent, useUsage, type AgentChanges } from "@/lib/state";
import { MOVE, SHOW } from "@/lib/motion";
import { useTheme } from "@/lib/theme";

const SPEEDS = { standard: "Standard", fast: "Fast" };

export default function ModelDrawer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgent(id);
  return agent ? <Model agent={agent} /> : null;
}

/**
 * The drawer the model's button in the message field opens: a provider's
 * logo and name over its models, a row to each. A person who has set up more
 * than one provider picks between them above the models, which fade in once
 * the computer has said which it has set up, and a model of
 * another provider moves the agent there, with its effort when that provider
 * has it. Under the models of the agent's own provider are how hard it can
 * think before it answers, and its speed when its model has a fast mode,
 * which says while it is fast that fast uses more of the plan. A check marks
 * what is in effect. A tap on anything else takes effect from
 * the agent's next turn, and the drawer stays up for another choice until it
 * is swiped away.
 */
function Model({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  // The providers the person has set up, which the computer lists with how each is signed in to.
  const providers = (useUsage()?.accounts ?? []).map((account) => account.provider);
  useEffect(() => {
    loadUsage().catch(() => {});
  }, []);
  // The provider whose models are listed, which starts as the agent's own.
  const [listed, setListed] = useState(agent.provider);
  const provider: Offered = PROVIDERS[listed];
  const own = listed === agent.provider;
  const change = (changes: AgentChanges) => void changeAgent(agent.id, changes).catch((failure) => problem("Couldn't change that", failure));
  const pick = (model: AgentWithLatest["model"]) => change(own ? { model } : { provider: listed, model, effort: Object.hasOwn(provider.efforts, agent.effort) ? agent.effort : PROVIDERS[listed].effort });
  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.page}>
      <View style={styles.provider}>
        <BrandLogo logo={provider.logo} size={22} />
        <Text accessibilityRole="header" style={[styles.name, { color: theme.ink }]}>
          {provider.name}
        </Text>
      </View>
      {providers.length > 1 ? (
        <Animated.View entering={SHOW} layout={MOVE} style={[styles.providers, { backgroundColor: theme.field }]}>
          <Choices options={Object.fromEntries(providers.map((each) => [each, PROVIDERS[each].name])) as Partial<Record<Provider, string>>} value={listed} onChange={setListed} plain />
        </Animated.View>
      ) : null}
      <Section title="Model">
        <Options options={provider.models} value={own ? agent.model : undefined} onChange={pick} />
      </Section>
      {own ? (
        <Section
          title="Effort"
          note="How hard it thinks before it answers. A more capable model and more effort are slower, and use more of your plan or API credit. A model without the effort you pick runs at the highest it has.">
          <Options options={provider.efforts} value={agent.effort} onChange={(effort) => change({ effort })} />
        </Section>
      ) : null}
      {own && provider.fast.includes(agent.model) ? (
        <Section title="Speed" note={runsFast(agent) ? "Fast uses more of your plan or API credit." : undefined}>
          <Choices options={SPEEDS} value={runsFast(agent) ? "fast" : "standard"} onChange={(speed) => change({ fast: speed === "fast" })} plain />
        </Section>
      ) : null}
    </ScrollView>
  );
}

/** A card's rows of choices where one may be in effect, which wears the check. */
function Options<Id extends string>({ options, value, onChange }: { options: Partial<Record<Id, string>>; value: Id | undefined; onChange: (value: Id) => void }) {
  const theme = useTheme();
  return (Object.keys(options) as Id[]).map((id, index) => (
    <Fragment key={id}>
      {index ? <Rule /> : null}
      <Pressable
        onPress={() => id !== value && onChange(id)}
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
  providers: { marginTop: 20, borderRadius: 16, borderCurve: "continuous" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 50 },
  rowTitle: { flex: 1, fontSize: 16, lineHeight: 21 },
});
