import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { CircleCheck } from "lucide-react-native";
import { AgentRow } from "@/components/AgentList";
import { Section } from "@/components/Section";
import { SetupButton, SetupPage } from "@/components/SetupPage";
import { greeted, useMachine } from "@/lib/api";
import { askForPush, canAskForPush, openChat } from "@/lib/push";
import { useAgents } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/**
 * What a phone shows once it has paired, before its chats: the computer it
 * paired with and the agents that run there, then why to allow
 * notifications, with the button that has the phone ask. A phone that has
 * answered that before skips the second step. A tap on an agent opens its
 * chat, and otherwise the phone goes on to the chat it opens on.
 */
export default function Paired() {
  const theme = useTheme();
  const router = useRouter();
  const machine = useMachine();
  const agents = useAgents().filter((agent) => !agent.hidden);
  const [step, setStep] = useState<"agents" | "notifications">("agents");
  // The agent whose chat opens once the steps are over, when the person picked one.
  const [picked, setPicked] = useState<string>();
  // The steps are left once, though the phone may still be asking Apple for its token when the person taps on.
  const left = useRef(false);
  // However the screen is left, as by a tap on a notification, the phone has shown what it paired with, and the steps open nothing more.
  useEffect(
    () => () => {
      left.current = true;
      greeted();
    },
    [],
  );

  function finish(agentId = picked) {
    if (left.current) return;
    left.current = true;
    greeted();
    if (agentId) openChat(agentId);
    else router.back();
  }
  async function next(agentId?: string) {
    if (!(await canAskForPush())) return finish(agentId);
    setPicked(agentId);
    setStep("notifications");
  }

  if (step === "agents") {
    return (
      <SetupPage
        art={<CircleCheck size={72} strokeWidth={1.75} color={theme.ok} />}
        title={`Paired with ${machine ?? "your computer"}`}
        lead="Your agents run on that computer. This phone reaches them wherever you are."
        actions={<SetupButton onPress={() => void next()}>Continue</SetupButton>}>
        {agents.length ? (
          <Section title="Your agents">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} search="" online onPress={() => void next(agent.id)} />
            ))}
          </Section>
        ) : null}
      </SetupPage>
    );
  }
  const first = agents.at(0)?.name ?? "An agent";
  return (
    <SetupPage
      art={
        <View style={[styles.banner, { backgroundColor: theme.field }]}>
          <Image source={require("../../assets/icon.png")} style={styles.bannerIcon} accessibilityIgnoresInvertColors />
          <View style={styles.bannerWords}>
            <Text style={[styles.bannerName, { color: theme.ink }]}>{first}</Text>
            <Text style={[styles.bannerText, { color: theme.ink }]}>Three things today. Your 10:00 moved to 2:00, and one email needs an answer by noon.</Text>
          </View>
        </View>
      }
      title="Let your agents reach you"
      lead="They work while your phone is in your pocket. A morning brief, a finished piece of work or a question for you arrives as a notification."
      actions={
        <>
          <SetupButton onPress={() => void askForPush().catch(() => undefined).then(() => finish())}>Allow notifications</SetupButton>
          <SetupButton quiet onPress={() => finish()}>
            Not now
          </SetupButton>
        </>
      }
    />
  );
}

const BANNER_ICON = 38;

const styles = StyleSheet.create({
  // A notification as the phone shows one, to say what allowing them brings.
  banner: { alignSelf: "stretch", flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 24, borderCurve: "continuous" },
  bannerIcon: { width: BANNER_ICON, height: BANNER_ICON, borderRadius: BANNER_ICON * 0.225, borderCurve: "continuous" },
  bannerWords: { flex: 1 },
  bannerName: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  bannerText: { fontSize: 15, lineHeight: 20 },
});
