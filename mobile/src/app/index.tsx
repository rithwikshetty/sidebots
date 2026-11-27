import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { AgentList } from "@/components/AgentList";
import { useActivities } from "@/lib/activity";
import { useFresh } from "@/lib/api";
import { useSplit } from "@/lib/layout";
import { openLastChat, useChatOnScreen, usePush } from "@/lib/push";
import { useAgents, useBehind } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/**
 * The home screen: the chat's side of the window with no chat open. It stays
 * under every chat, so it keeps the app's notifications and Live Activities.
 * A phone that has just paired first shows what it paired with.
 * In a window of one column it opens the chat the person was last in, or
 * their first agent's, unless a chat is already on its way, as one a
 * notification's tap opens. So it shows only while there is no chat to open,
 * and is then the chat list, which points a person with none at the +
 * button and says which side to update when the computer and the app speak
 * different versions of the contract. A split window keeps the agents in
 * their own column, and the home screen there asks for one once there are
 * agents to choose from.
 */
export default function Home() {
  usePush();
  useActivities();
  const split = useSplit();
  const agents = useAgents();
  const behind = useBehind();
  const open = useChatOnScreen();
  // While a sheet or a chat is over it, the home screen opens nothing.
  const inFront = usePathname() === "/";
  const router = useRouter();
  const fresh = useFresh();
  useEffect(() => {
    if (!inFront) return;
    if (fresh) router.push("/paired");
    else if (!split && !behind && !open) openLastChat(agents);
  }, [inFront, fresh, router, split, behind, open, agents]);
  return split ? <BesideAgents /> : <AgentList />;
}

function BesideAgents() {
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
