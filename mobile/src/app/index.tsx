import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Menu, Plus } from "lucide-react-native";
import { BEHIND_NOTE, BarButton, Notice } from "@/components/AgentList";
import { useActivities } from "@/lib/activity";
import { UPDATE } from "@/lib/api";
import { useSideMenu, useSplit, useWindowControls } from "@/lib/layout";
import { lastChat, openChat, useChatOnScreen, usePush } from "@/lib/push";
import { useAgents, useAvatars, useBehind } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/**
 * The home screen: the chat's side of the window with no chat open. It stays
 * under every chat, so it keeps the app's notifications and Live Activities.
 * In a window of one column it opens the chat the person was last in, or
 * their first agent's, so it shows only while there is no chat to open: to a
 * person with no agents yet, who is pointed at the + button, and when the
 * computer and the app speak different versions of the contract, with a line
 * saying which to update. A split window keeps the agents in their own
 * column, and the home screen there asks for one once there are agents to
 * choose from.
 */
export default function Home() {
  usePush();
  useActivities();
  const split = useSplit();
  const agents = useAgents();
  const behind = useBehind();
  const open = useChatOnScreen();
  // The agent whose chat it has opened, until that chat is on screen, so it opens one chat however often the agents change meanwhile.
  const opening = useRef<string | null>(null);
  useEffect(() => {
    if (open) opening.current = null;
    if (split || behind || open || agents.length === 0 || agents.some((agent) => agent.id === opening.current)) return;
    const last = lastChat();
    opening.current = agents.some((agent) => agent.id === last) ? last! : agents[0].id;
    openChat(opening.current);
  }, [split, behind, open, agents]);
  return split ? <BesideAgents /> : <NoChat />;
}

function BesideAgents() {
  const theme = useTheme();
  const agents = useAgents();
  const behind = useBehind();
  const choosable = agents.length > 0 && !behind;
  return (
    <View style={[styles.screen, styles.middle, { backgroundColor: theme.bg }]}>
      {choosable ? <Text style={[styles.note, { color: theme.ink2 }]}>Choose an agent to chat with.</Text> : null}
    </View>
  );
}

function NoChat() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const controls = useWindowControls();
  const menu = useSideMenu();
  const behind = useBehind();
  // The avatars come with the computer's first answer, so until then the phone can't tell whether there are no agents.
  const loaded = useAvatars().length > 0;
  const agents = useAgents();
  const empty = loaded && agents.length === 0;
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      {behind ? <Notice title={UPDATE[behind]} note={BEHIND_NOTE[behind]} /> : empty ? <Notice title="No agents yet" note="Tap + to make one, then tell it what it's for." /> : null}
      <View pointerEvents="box-none" style={[styles.bar, { top: insets.top, marginLeft: controls }]}>
        <BarButton icon={Menu} label="Agents" onPress={menu.open} />
        {behind ? null : <BarButton icon={Plus} label="New agent" onPress={() => router.push("/new-agent")} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  middle: { alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  note: { fontSize: 15, lineHeight: 20, textAlign: "center" },
  bar: { position: "absolute", left: 16, right: 16, flexDirection: "row", justifyContent: "space-between" },
});
