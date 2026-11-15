import { useEffect, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronRight, Trash2 } from "lucide-react-native";
import { EFFORTS, MODELS, scheduleWords, type AgentWithLatest, type Job } from "@server/contract";
import { IconButton } from "@/components/IconButton";
import { PetPicker } from "@/components/PetPicker";
import { PetView } from "@/components/PetView";
import { confirmDelete, problem } from "@/lib/alerts";
import { changeAgent, loadAbout, removeJob, useAbout, useAgent, type AgentChanges } from "@/lib/state";
import { useTheme } from "@/lib/theme";
import { nextTime } from "@/lib/time";

export default function AgentPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgent(id);
  return agent ? <AgentAbout agent={agent} /> : null;
}

/**
 * An agent's page, opened from its name at the top of its chat. It shows who
 * the agent is and lets the person change it: its name, its pet, its model
 * and effort, and whether it is muted or hidden. Below that is what the agent works from:
 * its jobs, which can be removed here, the instructions it follows and what
 * it remembers. The agent writes those three itself, as it is told things in
 * its chat. The page ends with Delete.
 */
function AgentAbout({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const about = useAbout(agent.id);
  const [name, setName] = useState(agent.name);

  useEffect(() => {
    loadAbout(agent.id).catch(() => {});
  }, [agent.id]);

  const change = (changes: AgentChanges) => void changeAgent(agent.id, changes).catch((failure) => problem("Couldn't change that", failure));
  const rename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== agent.name) change({ name: trimmed });
    else setName(agent.name);
  };
  const forget = (job: Job) =>
    Alert.alert("Remove this job?", scheduleWords(job.schedule), [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void removeJob(agent.id, job.id).catch((failure) => problem("Couldn't remove it", failure)) },
    ]);

  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={10} style={styles.done}>
        <Text style={[styles.doneText, { color: theme.tintInk }]}>Done</Text>
      </Pressable>
      <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={styles.face}>
          <PetView petId={agent.pet_id} state="resting" size={96} />
        </View>
        <TextInput
          value={name}
          onChangeText={setName}
          onEndEditing={rename}
          maxLength={24}
          returnKeyType="done"
          selectionColor={theme.tintInk}
          accessibilityLabel="Name"
          style={[styles.name, { color: theme.ink }]}
        />
        <PetPicker value={agent.pet_id} onChange={(petId) => change({ petId })} />

        <Section title="Model" note="What it answers with, and how hard it thinks first. Fable and High are the most capable, the slowest, and use the most of your subscription.">
          <Choices options={MODELS} value={agent.model} onChange={(model) => change({ model })} />
          <Rule />
          <Choices options={EFFORTS} value={agent.effort} onChange={(effort) => change({ effort })} />
        </Section>

        <Section>
          <Toggle title="Mute" note="No notifications from it" value={agent.muted} onChange={(muted) => change({ muted })} />
          <Rule />
          <Toggle title="Hide" note="Off the list until it next has something to say" value={agent.hidden} onChange={(hidden) => change({ hidden })} />
        </Section>

        <Section title="Jobs" note={about?.jobs.length ? undefined : "None. Ask it to remind you of something, or to keep an eye on something."}>
          {about?.jobs.map((job, index) => (
            <View key={job.id}>
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
            </View>
          ))}
        </Section>

        <Section title="Instructions">
          <Pressable onPress={() => router.push({ pathname: "/note", params: { agent: agent.id } })} style={styles.row}>
            <Text numberOfLines={4} style={[styles.rowText, styles.rowNote, { color: theme.ink2 }]}>
              {about?.instructions.trim() || "Nothing yet."}
            </Text>
            <ChevronRight size={18} color={theme.ink2} />
          </Pressable>
        </Section>

        <Section title="Memory" note={about?.memories.length ? undefined : "Nothing yet. It saves what it learns as you talk."}>
          {about?.memories.map((memory, index) => (
            <View key={memory.name}>
              {index > 0 ? <Rule /> : null}
              <Pressable onPress={() => router.push({ pathname: "/note", params: { agent: agent.id, memory: memory.name } })} style={styles.row}>
                <Text numberOfLines={2} style={[styles.rowText, styles.rowTitle, { color: theme.ink }]}>
                  {memory.description || memory.name}
                </Text>
                <ChevronRight size={18} color={theme.ink2} />
              </Pressable>
            </View>
          ))}
        </Section>

        <Section>
          <Pressable onPress={() => confirmDelete(agent, () => router.dismissAll())} accessibilityRole="button" style={styles.row}>
            <Text style={[styles.rowTitle, { color: theme.danger }]}>Delete agent</Text>
          </Pressable>
        </Section>
      </ScrollView>
    </View>
  );
}

/** A group of rows on a card, under its title, with a line of help below. A group with no rows shows only its title and help. */
function Section({ title, note, children }: { title?: string; note?: string; children?: ReactNode }) {
  const theme = useTheme();
  const rows = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  return (
    <View style={styles.section}>
      {title ? <Text style={[styles.sectionTitle, { color: theme.ink2 }]}>{title}</Text> : null}
      {rows ? <View style={[styles.card, { backgroundColor: theme.field }]}>{children}</View> : null}
      {note ? <Text style={[styles.sectionNote, { color: theme.ink2 }]}>{note}</Text> : null}
    </View>
  );
}

/** A row of choices where one is in effect, as for the model. */
function Choices<Id extends string>({ options, value, onChange }: { options: Record<Id, string>; value: Id; onChange: (value: Id) => void }) {
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

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  page: { paddingHorizontal: 20 },
  // Done stays at the sheet's top while the page scrolls under it.
  done: { alignSelf: "flex-end", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  doneText: { fontSize: 17, fontWeight: "600" },
  face: { alignItems: "center", marginTop: 4 },
  name: { fontSize: 26, fontWeight: "700", textAlign: "center", paddingVertical: 8, marginBottom: 12 },
  section: { marginTop: 28, gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4, paddingHorizontal: 4 },
  sectionNote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  card: { borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 50 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, lineHeight: 21 },
  rowNote: { fontSize: 14, lineHeight: 19 },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  choices: { flexDirection: "row", padding: 4, gap: 4 },
  choice: { flex: 1, height: 38, borderRadius: 12, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  choiceText: { fontSize: 15, fontWeight: "600" },
});
