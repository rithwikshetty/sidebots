import { StyleSheet, Text, View } from "react-native";
import { AgentList } from "@/components/AgentList";
import { useSplit } from "@/lib/layout";
import { useAgents, useBehind } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/**
 * The home screen: the person's agents. A split window keeps them in their
 * own column, so here it is the chat's side with no chat open, which asks
 * for an agent once there are agents to choose from.
 */
export default function Home() {
  return useSplit() ? <NoChat /> : <AgentList />;
}

function NoChat() {
  const theme = useTheme();
  const agents = useAgents();
  const behind = useBehind();
  const choosable = agents.length > 0 && !behind;
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      {choosable ? <Text style={[styles.note, { color: theme.ink2 }]}>Choose an agent to chat with.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  note: { fontSize: 15, lineHeight: 20, textAlign: "center" },
});
