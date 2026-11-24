import { useEffect, useState } from "react";
import { Alert, Keyboard, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { ChevronRight, Trash2 } from "lucide-react-native";
import { PROVIDERS, USAGE_DAYS, scheduleWords, type AgentWithLatest, type Job, type Offered } from "@server/contract";
import { nextTime } from "@client/time";
import { COST_NOTE, KINDS, dollars, usedBy } from "@client/usage";
import { AvatarPicker } from "@/components/AvatarPicker";
import { AvatarView } from "@/components/AvatarView";
import { Choices } from "@/components/Choices";
import { ColorPicker } from "@/components/ColorPicker";
import { FadingText } from "@/components/FadingText";
import { IconButton } from "@/components/IconButton";
import { Rule, Section, SectionTitle } from "@/components/Section";
import { confirmDelete, problem } from "@/lib/alerts";
import { HIDE, MOVE, POP_IN, SHOW } from "@/lib/motion";
import { changeAgent, loadAbout, loadUsage, removeJob, useAbout, useAgent, useChatColor, useUsage, type AgentChanges } from "@/lib/state";
import { useTheme } from "@/lib/theme";

const TABS = { settings: "Settings", work: "Jobs & memory" } as const;
type Tab = keyof typeof TABS;

export default function AgentPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgent(id);
  return agent ? <AgentAbout agent={agent} /> : null;
}

/**
 * An agent's page, opened from its avatar at the top of its chat. It opens on
 * the agent's avatar, large, with its name and the model it answers with. Edit
 * turns the name into a field and brings up the avatars and the colours of its
 * chat to choose from, and Save keeps them. Below are two tabs. Settings
 * holds what the agent used in the last days, Mute and Hide, and Delete.
 * Jobs & memory holds what the agent works from: its jobs, which can be
 * removed here, the instructions it follows and what it remembers. The agent
 * writes those three itself, as it is told things in its chat. What loads
 * after the page opens fades in, and the sections below slide down to make
 * room for it.
 */
function AgentAbout({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("settings");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [avatarId, setAvatarId] = useState(agent.avatar_id);
  const [color, setColor] = useState(agent.color ?? null);
  // The colour of the avatar being picked, which the chat takes when no colour of its own is picked.
  const avatarColor = useChatColor({ avatar_id: avatarId, color: null });

  useEffect(() => {
    loadAbout(agent.id).catch(() => {});
    loadUsage().catch(() => {});
  }, [agent.id]);

  const change = (changes: AgentChanges) => void changeAgent(agent.id, changes).catch((failure) => problem("Couldn't change that", failure));
  const edit = () => {
    setName(agent.name);
    setAvatarId(agent.avatar_id);
    setColor(agent.color ?? null);
    setEditing(true);
  };
  const save = () => {
    const trimmed = name.trim();
    const changes: AgentChanges = {};
    if (trimmed !== agent.name) changes.name = trimmed;
    if (avatarId !== agent.avatar_id) changes.avatarId = avatarId;
    if (color !== (agent.color ?? null)) changes.color = color;
    if (Object.keys(changes).length) change(changes);
    Keyboard.dismiss();
    setEditing(false);
  };
  const cancel = () => {
    Keyboard.dismiss();
    setEditing(false);
  };
  const shownAvatar = editing ? avatarId : agent.avatar_id;

  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      <View style={styles.bar}>
        <BarButton label={editing ? "Cancel" : "Edit"} onPress={editing ? cancel : edit} />
        <BarButton label={editing ? "Save" : "Done"} strong disabled={editing && !name.trim()} onPress={editing ? save : () => router.back()} />
      </View>
      {/* What the page opens with shows as it is; what loads or changes after fades in. */}
      <LayoutAnimationConfig skipEntering>
        <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <View style={styles.hero}>
            <View style={[styles.halo, { backgroundColor: theme.field }]}>
              {/* A newly picked avatar pops in where the last one was. */}
              <Animated.View key={shownAvatar} entering={POP_IN}>
                <AvatarView avatarId={shownAvatar} state="resting" size={88} />
              </Animated.View>
            </View>
            {editing ? (
              <Animated.View key="name-field" entering={SHOW} exiting={HIDE} style={styles.identity}>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  maxLength={24}
                  returnKeyType="done"
                  selectionColor={theme.tintInk}
                  placeholder="Name"
                  placeholderTextColor={theme.ink2}
                  accessibilityLabel="Name"
                  style={[styles.nameField, { color: theme.ink, backgroundColor: theme.field }]}
                />
              </Animated.View>
            ) : (
              <Animated.View key="name" entering={SHOW} exiting={HIDE} style={styles.identity}>
                <Text numberOfLines={1} style={[styles.name, { color: theme.ink }]}>
                  {agent.name}
                </Text>
                <FadingText style={[styles.caption, { color: theme.ink2 }]}>{caption(agent)}</FadingText>
              </Animated.View>
            )}
          </View>

          {editing ? (
            <Animated.View key="editing" entering={SHOW} exiting={HIDE} style={styles.section}>
              <SectionTitle>Avatar</SectionTitle>
              <AvatarPicker value={avatarId} onChange={setAvatarId} />
              <SectionTitle style={styles.later}>Chat colour</SectionTitle>
              <ColorPicker value={color} avatarColor={avatarColor} onChange={setColor} />
            </Animated.View>
          ) : (
            <Animated.View key="tabs" entering={SHOW} exiting={HIDE}>
              <View style={[styles.tabs, { backgroundColor: theme.field }]}>
                <Choices options={TABS} value={tab} onChange={setTab} plain />
              </View>
              {/* The tabs crossfade as one is picked. */}
              <Animated.View key={tab} entering={SHOW} exiting={HIDE}>
                {tab === "settings" ? <SettingsTab agent={agent} change={change} /> : <WorkTab agent={agent} />}
              </Animated.View>
            </Animated.View>
          )}
        </ScrollView>
      </LayoutAnimationConfig>
    </View>
  );
}

/** The line under the agent's name: its model and effort, and whether it is muted or hidden. */
function caption(agent: AgentWithLatest): string {
  const { models, efforts }: Offered = PROVIDERS[agent.provider];
  return [`${models[agent.model]} · ${efforts[agent.effort]} effort`, agent.muted ? "Muted" : null, agent.hidden ? "Hidden" : null].filter(Boolean).join(" · ");
}

function SettingsTab({ agent, change }: { agent: AgentWithLatest; change: (changes: AgentChanges) => void }) {
  const theme = useTheme();
  return (
    <>
      <UsedSection agentId={agent.id} />

      <Section>
        <Toggle title="Mute" note="No notifications from it" value={agent.muted} onChange={(muted) => change({ muted })} />
        <Rule />
        <Toggle title="Hide" note="Off the list until it next has something to say" value={agent.hidden} onChange={(hidden) => change({ hidden })} />
      </Section>

      <Section>
        <Pressable onPress={() => confirmDelete(agent)} accessibilityRole="button" style={styles.row}>
          <Text style={[styles.rowTitle, { color: theme.danger }]}>Delete agent</Text>
        </Pressable>
      </Section>
    </>
  );
}

/** What the agent used in the last days, a kind of turn to a row: how many it ran and what they cost. It fades in once the computer has said. */
function UsedSection({ agentId }: { agentId: string }) {
  const theme = useTheme();
  const usage = useUsage();
  if (!usage) return null;
  const used = usedBy(usage, agentId);
  return (
    <Animated.View entering={SHOW} layout={MOVE}>
      <Section title={`Usage, last ${USAGE_DAYS} days`} note={used.length ? COST_NOTE : "It hasn't run a turn."}>
        {used.map((each, index) => (
          <Animated.View key={each.kind} entering={SHOW} exiting={HIDE} layout={MOVE}>
            {index > 0 ? <Rule /> : null}
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: theme.ink }]}>{KINDS[each.kind]}</Text>
                <FadingText style={[styles.rowNote, { color: theme.ink2 }]}>{each.turns === 1 ? "1 turn" : `${each.turns} turns`}</FadingText>
              </View>
              <FadingText style={[styles.rowTitle, { color: theme.ink2 }]}>{dollars(each.cost)}</FadingText>
            </View>
          </Animated.View>
        ))}
      </Section>
    </Animated.View>
  );
}

function WorkTab({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const router = useRouter();
  const about = useAbout(agent.id);
  const forget = (job: Job) =>
    Alert.alert("Remove this job?", scheduleWords(job.schedule), [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void removeJob(agent.id, job.id).catch((failure) => problem("Couldn't remove it", failure)) },
    ]);
  return (
    <>
      <Section title="Jobs" note={about?.jobs.length ? undefined : "None. Ask it to remind you of something, or to keep an eye on something."}>
        {about?.jobs.map((job, index) => (
          <Animated.View key={job.id} entering={SHOW} exiting={HIDE} layout={MOVE}>
            {index > 0 ? <Rule /> : null}
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: theme.ink }]}>{scheduleWords(job.schedule)}</Text>
                <Text style={[styles.rowNote, { color: theme.ink2 }]}>Next {nextTime(job.next_at)}</Text>
                <Text numberOfLines={3} style={[styles.rowNote, { color: theme.ink2 }]}>
                  {job.what}
                </Text>
              </View>
              <IconButton icon={Trash2} label="Remove job" iconSize={18} color={theme.danger} onPress={() => forget(job)} />
            </View>
          </Animated.View>
        ))}
      </Section>

      <Section title="Instructions">
        <Pressable onPress={() => router.push({ pathname: "/note", params: { agent: agent.id } })} style={styles.row}>
          <FadingText numberOfLines={4} style={[styles.rowText, styles.rowNote, { color: theme.ink2 }]}>
            {about?.instructions.trim() || "Nothing yet."}
          </FadingText>
          <ChevronRight size={18} color={theme.ink2} />
        </Pressable>
      </Section>

      <Section title="Memory" note={about?.memories.length ? undefined : "Nothing yet. It saves what it learns as you talk."}>
        {about?.memories.map((memory, index) => (
          <Animated.View key={memory.name} entering={SHOW} exiting={HIDE} layout={MOVE}>
            {index > 0 ? <Rule /> : null}
            <Pressable onPress={() => router.push({ pathname: "/note", params: { agent: agent.id, memory: memory.name } })} style={styles.row}>
              <Text numberOfLines={2} style={[styles.rowText, styles.rowTitle, { color: theme.ink }]}>
                {memory.description || memory.name}
              </Text>
              <ChevronRight size={18} color={theme.ink2} />
            </Pressable>
          </Animated.View>
        ))}
      </Section>
    </>
  );
}

/** A word at the sheet's top, as Edit or Done. `strong` is the one that finishes. */
function BarButton({ label, strong = false, disabled = false, onPress }: { label: string; strong?: boolean; disabled?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} hitSlop={10} style={({ pressed }) => ({ opacity: disabled ? 0.35 : pressed ? 0.6 : 1 })}>
      <FadingText style={[styles.barText, strong && styles.barStrong, { color: theme.tintInk }]}>{label}</FadingText>
    </Pressable>
  );
}

function Toggle({ title, note, value, onChange }: { title: string; note: string; value: boolean; onChange: (value: boolean) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: theme.ink }]}>{title}</Text>
        <Text style={[styles.rowNote, { color: theme.ink2 }]}>{note}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: theme.tint }} accessibilityLabel={title} />
    </View>
  );
}

const HALO = 132;

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  // Edit and Done stay at the sheet's top while the page scrolls under them.
  bar: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  barText: { fontSize: 17 },
  barStrong: { fontWeight: "600" },
  page: { paddingHorizontal: 20 },
  hero: { alignItems: "center", gap: 14, marginTop: 4 },
  halo: { width: HALO, height: HALO, borderRadius: HALO / 2, alignItems: "center", justifyContent: "center" },
  identity: { alignItems: "center", gap: 4, alignSelf: "stretch", minHeight: 58 },
  name: { fontSize: 28, fontWeight: "700", letterSpacing: 0.2 },
  caption: { fontSize: 15 },
  nameField: { alignSelf: "stretch", height: 50, borderRadius: 14, borderCurve: "continuous", paddingHorizontal: 16, fontSize: 22, fontWeight: "600", textAlign: "center" },
  tabs: { marginTop: 24, borderRadius: 16, borderCurve: "continuous" },
  // The avatars and colours to choose from, set out as a section is.
  section: { marginTop: 24, gap: 8 },
  // A second title in one section, set apart from what is above it.
  later: { marginTop: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 50 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, lineHeight: 21 },
  rowNote: { fontSize: 14, lineHeight: 19 },
});
