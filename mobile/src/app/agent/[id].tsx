import { useEffect, useState, type ReactNode } from "react";
import { Alert, Keyboard, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { ChevronRight, Trash2 } from "lucide-react-native";
import { EFFORTS, MODELS, scheduleWords, type AgentWithLatest, type Job } from "@server/contract";
import { AvatarPicker } from "@/components/AvatarPicker";
import { AvatarView } from "@/components/AvatarView";
import { Choices } from "@/components/Choices";
import { FadingText } from "@/components/FadingText";
import { IconButton } from "@/components/IconButton";
import { confirmDelete, problem } from "@/lib/alerts";
import { HIDE, MOVE, POP_IN, SHOW } from "@/lib/motion";
import { changeAgent, loadAbout, removeJob, useAbout, useAgent, type AgentChanges } from "@/lib/state";
import { useTheme } from "@/lib/theme";
import { nextTime } from "@/lib/time";

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
 * turns the name into a field and brings up the avatars to choose from, and
 * Save keeps both. Below are two tabs. Settings holds the model and effort,
 * Mute and Hide, and Delete. Jobs & memory holds what the agent works from:
 * its jobs, which can be removed here, the instructions it follows and what
 * it remembers. The agent writes those three itself, as it is told things
 * in its chat. What loads after the page opens fades in, and the sections
 * below slide down to make room for it.
 */
function AgentAbout({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("settings");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [avatarId, setAvatarId] = useState(agent.avatar_id);

  useEffect(() => {
    loadAbout(agent.id).catch(() => {});
  }, [agent.id]);

  const change = (changes: AgentChanges) => void changeAgent(agent.id, changes).catch((failure) => problem("Couldn't change that", failure));
  const edit = () => {
    setName(agent.name);
    setAvatarId(agent.avatar_id);
    setEditing(true);
  };
  const save = () => {
    const trimmed = name.trim();
    const changes: AgentChanges = {};
    if (trimmed !== agent.name) changes.name = trimmed;
    if (avatarId !== agent.avatar_id) changes.avatarId = avatarId;
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
              <Text style={[styles.sectionTitle, { color: theme.ink2 }]}>Avatar</Text>
              <AvatarPicker value={avatarId} onChange={setAvatarId} />
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
  return [`${MODELS[agent.model]} · ${EFFORTS[agent.effort]} effort`, agent.muted ? "Muted" : null, agent.hidden ? "Hidden" : null].filter(Boolean).join(" · ");
}

function SettingsTab({ agent, change }: { agent: AgentWithLatest; change: (changes: AgentChanges) => void }) {
  const theme = useTheme();
  const router = useRouter();
  return (
    <>
      <Section title="Model" note="What it answers with, and how hard it thinks first. Fable and High are the most capable, the slowest, and use the most of your Claude subscription or API credit.">
        <Choices options={MODELS} value={agent.model} onChange={(model) => change({ model })} />
        <Rule />
        <Choices options={EFFORTS} value={agent.effort} onChange={(effort) => change({ effort })} />
      </Section>

      <Section>
        <Toggle title="Mute" note="No notifications from it" value={agent.muted} onChange={(muted) => change({ muted })} />
        <Rule />
        <Toggle title="Hide" note="Off the list until it next has something to say" value={agent.hidden} onChange={(hidden) => change({ hidden })} />
      </Section>

      <Section>
        <Pressable onPress={() => confirmDelete(agent, () => router.dismissAll())} accessibilityRole="button" style={styles.row}>
          <Text style={[styles.rowTitle, { color: theme.danger }]}>Delete agent</Text>
        </Pressable>
      </Section>
    </>
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

/**
 * A group of rows on a card, under its title, with a line of help below. A
 * group with no rows shows only its title and help. The card and the help
 * fade in and out as rows come and go, and the group slides as it changes size.
 */
function Section({ title, note, children }: { title?: string; note?: string; children?: ReactNode }) {
  const theme = useTheme();
  const rows = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  return (
    <Animated.View layout={MOVE} style={styles.section}>
      {title ? <Text style={[styles.sectionTitle, { color: theme.ink2 }]}>{title}</Text> : null}
      {rows ? (
        <Animated.View entering={SHOW} exiting={HIDE} layout={MOVE} style={[styles.card, { backgroundColor: theme.field }]}>
          {children}
        </Animated.View>
      ) : null}
      {note ? <FadingText style={[styles.sectionNote, { color: theme.ink2 }]}>{note}</FadingText> : null}
    </Animated.View>
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

function Rule() {
  const theme = useTheme();
  return <View style={[styles.rule, { backgroundColor: theme.line }]} />;
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
  section: { marginTop: 24, gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4, paddingHorizontal: 4 },
  sectionNote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  card: { borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 50 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, lineHeight: 21 },
  rowNote: { fontSize: 14, lineHeight: 19 },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
});
