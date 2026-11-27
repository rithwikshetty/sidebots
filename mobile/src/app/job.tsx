import { useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { WEEK, WEEKDAYS, type Schedule } from "@server/contract";
import { jobChanges, jobDraft, toggleDay, type JobDraft } from "@client/jobs";
import { BarButton } from "@/components/BarButton";
import { Choices } from "@/components/Choices";
import { FadingText } from "@/components/FadingText";
import { Rule, Section } from "@/components/Section";
import { confirmDeleteJob, problem } from "@/lib/alerts";
import { runJob, saveJob, useAbout } from "@/lib/state";
import { useTheme } from "@/lib/theme";

const KINDS: Record<Schedule["type"], string> = { daily: "At a time", once: "Once", every: "Interval" };

const two = (value: number) => String(value).padStart(2, "0");
/** A time of day as a picker holds it: today at that time. */
const timeValue = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  return at;
};

/**
 * A job of an agent's, opened from its page, or a new one with no `job`: its
 * name, what the agent does on each run, when it runs and whether it runs.
 * Save keeps it, and leaves a schedule it still has as it was, so its next
 * run stays. A job that is saved can also be run now, beside its schedule,
 * or deleted.
 */
export default function JobSheet() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { agent: agentId, job: jobId } = useLocalSearchParams<{ agent: string; job?: string }>();
  const job = useAbout(agentId)?.jobs.find((each) => each.id === jobId) ?? null;
  const [draft, setDraft] = useState(() => jobDraft(job));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change = (patch: Partial<JobDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    Keyboard.dismiss();
    setSaving(true);
    try {
      await saveJob(agentId, jobChanges(draft, job), job?.id);
      router.back();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save it.");
      setSaving(false);
    }
  };
  const runNow = () => {
    if (!job) return;
    runJob(agentId, job.id).then(
      () => router.back(),
      (failure) => problem("Couldn't run it", failure),
    );
  };
  const remove = () => job && confirmDeleteJob(job, () => router.back());

  const field = [styles.field, { color: theme.ink }];
  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      <View style={styles.bar}>
        <BarButton label="Cancel" onPress={() => router.back()} />
        <Text style={[styles.barTitle, { color: theme.ink }]}>{job ? "Edit job" : "New job"}</Text>
        <BarButton label="Save" strong disabled={saving} onPress={() => void save()} />
      </View>
      <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 32 }]} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Section note="The agent runs it by itself, in a session of its own, and what it finds comes to its chat.">
          <TextInput
            value={draft.title}
            onChangeText={(title) => change({ title })}
            placeholder="Name, such as Morning brief"
            placeholderTextColor={theme.ink2}
            selectionColor={theme.tintInk}
            autoFocus={!job}
            returnKeyType="next"
            accessibilityLabel="Name"
            style={field}
          />
          <Rule />
          <TextInput
            value={draft.what}
            onChangeText={(what) => change({ what })}
            placeholder="What should the agent do each time this runs?"
            placeholderTextColor={theme.ink2}
            selectionColor={theme.tintInk}
            multiline
            accessibilityLabel="Instructions"
            style={[field, styles.instructions]}
          />
        </Section>

        <Section title="Schedule">
          <Choices options={KINDS} value={draft.kind} onChange={(kind) => change({ kind })} />
          <Rule />
          {draft.kind === "daily" ? (
            <>
              <View style={styles.row}>
                <Text style={[styles.label, { color: theme.ink }]}>Time</Text>
                <DateTimePicker
                  value={timeValue(draft.time)}
                  mode="time"
                  display="compact"
                  accentColor={theme.tint}
                  onValueChange={(_, picked) => change({ time: `${two(picked.getHours())}:${two(picked.getMinutes())}` })}
                />
              </View>
              <Rule />
              <View style={styles.days} accessibilityRole="toolbar" accessibilityLabel="Days to run">
                {WEEK.map((day) => {
                  const on = draft.weekdays.includes(day);
                  return (
                    <Pressable
                      key={day}
                      onPress={() => change({ weekdays: toggleDay(draft, day) })}
                      accessibilityRole="button"
                      accessibilityLabel={WEEKDAYS[day]}
                      accessibilityState={{ selected: on }}
                      style={[styles.day, { backgroundColor: on ? theme.tint : theme.bg }]}
                    >
                      <Text style={[styles.dayText, { color: on ? theme.onTint : theme.ink2 }]}>{WEEKDAYS[day].slice(0, 1)}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : draft.kind === "once" ? (
            <View style={styles.row}>
              <Text style={[styles.label, { color: theme.ink }]}>Runs on</Text>
              <DateTimePicker value={new Date(draft.at)} mode="datetime" display="compact" minimumDate={new Date()} accentColor={theme.tint} onValueChange={(_, picked) => change({ at: picked.getTime() })} />
            </View>
          ) : (
            <View style={styles.row}>
              <Text style={[styles.label, { color: theme.ink }]}>Every</Text>
              <TextInput
                value={draft.minutes}
                onChangeText={(minutes) => change({ minutes: minutes.replace(/\D/g, "") })}
                keyboardType="number-pad"
                selectionColor={theme.tintInk}
                accessibilityLabel="Minutes"
                style={[styles.minutes, { color: theme.ink, backgroundColor: theme.bg }]}
              />
              <Text style={[styles.unit, { color: theme.ink2 }]}>{draft.minutes === "1" ? "minute" : "minutes"}</Text>
            </View>
          )}
        </Section>

        <Section note="A paused job stays saved but doesn't run.">
          <View style={styles.row}>
            <Text style={[styles.label, { color: theme.ink }]}>Enabled</Text>
            <Switch value={draft.enabled} onValueChange={(enabled) => change({ enabled })} trackColor={{ true: theme.tint }} accessibilityLabel="Enabled" />
          </View>
        </Section>

        {error ? <FadingText style={[styles.error, { color: theme.danger }]}>{error}</FadingText> : null}

        {job ? (
          <Section>
            <Pressable onPress={runNow} accessibilityRole="button" style={styles.row}>
              <Text style={[styles.label, { color: theme.tintInk }]}>Run now</Text>
            </Pressable>
            <Rule />
            <Pressable onPress={remove} accessibilityRole="button" style={styles.row}>
              <Text style={[styles.label, { color: theme.danger }]}>Delete job</Text>
            </Pressable>
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  // Cancel and Save stay at the sheet's top while the form scrolls under them.
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  barTitle: { fontSize: 17, fontWeight: "600" },
  page: { paddingHorizontal: 20 },
  field: { fontSize: 16, lineHeight: 21, paddingHorizontal: 16, paddingVertical: 14, minHeight: 50 },
  instructions: { minHeight: 132, textAlignVertical: "top" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 8, minHeight: 50 },
  label: { flex: 1, fontSize: 16, lineHeight: 21 },
  days: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 12 },
  day: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  dayText: { fontSize: 15, fontWeight: "600" },
  minutes: { width: 72, height: 36, borderRadius: 10, borderCurve: "continuous", paddingHorizontal: 10, fontSize: 16, textAlign: "right" },
  unit: { fontSize: 16 },
  error: { fontSize: 14, lineHeight: 19, marginTop: 16, paddingHorizontal: 4 },
});
