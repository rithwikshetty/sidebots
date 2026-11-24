import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { PROVIDERS, USAGE_DAYS, type Day, type Limit, type Usage } from "@server/contract";
import { dayLabel, listTime, nextTime } from "@client/time";
import { COST_NOTE, KINDS, MEASURES, TOKENS_NOTE, amount, dayTime, sum, usedBy, type Measure } from "@client/usage";
import { AvatarView } from "@/components/AvatarView";
import { Bar } from "@/components/Bar";
import { Choices } from "@/components/Choices";
import { FadingText } from "@/components/FadingText";
import { Rule, Section } from "@/components/Section";
import { ApiError, UPDATE } from "@/lib/api";
import { EASE, HIDE, MOVE, SHOW } from "@/lib/motion";
import { loadUsage, useAgents, useUsage } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/**
 * Where the person's plan or API credit goes, opened from the side menu.
 * First, for each provider their agents sign in to with a plan, how much of
 * each of the plan's limits is left and when it resets, as the provider says
 * when the computer asks it. Then the last days, by cost or by tokens as the
 * person picks: what each day used, as bars, and the agents that ran a turn,
 * the one that used most first, each with its share of what all of them used
 * and how that splits between its replies, its jobs and its fresh starts. It
 * opens on what the phone last had, and what the computer then says fades in,
 * as a plan's limits do when the provider answers.
 */
export default function UsagePage() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const usage = useUsage();
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    loadUsage().catch((reason) => {
      // A Sidebots on the computer that doesn't count usage answers that it has no such thing.
      if (reason instanceof ApiError && reason.status === 404) return setFailure(`${UPDATE.computer} to see what your agents use.`);
      setFailure(reason instanceof Error ? reason.message : "Something went wrong.");
    });
  }, []);
  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={10} style={styles.done}>
        <Text style={[styles.doneText, { color: theme.tintInk }]}>Done</Text>
      </Pressable>
      <LayoutAnimationConfig skipEntering>
        <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 32 }]}>
          <Text accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>
            Usage
          </Text>
          {usage ? (
            <Animated.View entering={SHOW}>
              {usage.accounts.map((account) => (
                <Plan key={account.provider} account={account} />
              ))}
              <LastDays usage={usage} />
            </Animated.View>
          ) : failure ? (
            <FadingText style={[styles.failure, { color: theme.ink2 }]}>{failure}</FadingText>
          ) : null}
        </ScrollView>
      </LayoutAnimationConfig>
    </View>
  );
}

/** A provider the person's agents sign in to: the limits of their plan with it, or that an API key pays instead. */
function Plan({ account }: { account: Usage["accounts"][number] }) {
  const { name } = PROVIDERS[account.provider];
  if (account.apiKey) return <Section title={name} note="Your agents run on an API key, which has no plan to run out. The key's account is billed for what they use." />;
  const said = Math.max(...account.limits.map((limit) => limit.at));
  return (
    <Section
      title={`${name} plan`}
      note={
        account.limits.length
          ? `As ${name} said, ${listTime(said)}. It counts what you use outside Sidebots too.`
          : `${name} hasn't said how much of your plan is left.`
      }>
      {account.limits.map((limit, index) => (
        <Animated.View key={limit.name} entering={SHOW} exiting={HIDE} layout={MOVE}>
          {index > 0 ? <Rule /> : null}
          <LimitRow limit={limit} />
        </Animated.View>
      ))}
    </Section>
  );
}

/** One limit of a plan: how much of it is left, as words and as a bar, and when it resets. */
function LimitRow({ limit }: { limit: Limit }) {
  const theme = useTheme();
  const left = limit.used === null ? null : Math.round(Math.max(1 - limit.used, 0) * 100);
  return (
    <View style={styles.row}>
      <View style={styles.line}>
        <Text style={[styles.name, { color: theme.ink }]}>{limit.name}</Text>
        {left === null ? null : <FadingText style={[styles.amount, { color: left ? theme.ink2 : theme.danger }]}>{left ? `${left}% left` : "None left"}</FadingText>}
      </View>
      {left === null ? null : <Bar part={left / 100} label={`${limit.name}, left`} />}
      {limit.resets_at === null ? null : <FadingText style={[styles.note, { color: theme.ink2 }]}>{`Resets ${nextTime(limit.resets_at)}`}</FadingText>}
    </View>
  );
}

/** The last days by the measure the person picks: what each day used, then the agents that ran a turn in them, the one that used most first. */
function LastDays({ usage }: { usage: Usage }) {
  const theme = useTheme();
  const [measure, setMeasure] = useState<Measure>("cost");
  const rows = useAgents()
    .map((agent) => ({ agent, used: usedBy(usage, agent.id) }))
    .filter(({ used }) => used.length)
    .map((row) => ({ ...row, total: sum(row.used) }))
    .sort((a, b) => b.total[measure] - a.total[measure]);
  const all = sum(rows.map((row) => row.total));
  return (
    <Section title={`Last ${USAGE_DAYS} days`} note={usage.used.length ? (measure === "cost" ? COST_NOTE : TOKENS_NOTE) : "No agent has run a turn."}>
      {usage.used.length ? (
        <>
          <Choices options={MEASURES} value={measure} onChange={setMeasure} plain />
          <Days days={usage.days} measure={measure} />
          {rows.map(({ agent, used, total }) => (
            <Animated.View key={agent.id} entering={SHOW} exiting={HIDE} layout={MOVE}>
              <Rule />
              <View style={[styles.row, styles.agent]}>
                <AvatarView avatarId={agent.avatar_id} state="resting" size={40} />
                <View style={styles.agentText}>
                  <View style={styles.line}>
                    <Text numberOfLines={1} style={[styles.name, { color: theme.ink }]}>
                      {agent.name}
                    </Text>
                    <FadingText style={[styles.amount, { color: theme.ink2 }]}>{amount(measure, total)}</FadingText>
                  </View>
                  <Bar part={all[measure] ? total[measure] / all[measure] : 0} label={`${agent.name}'s share`} />
                  <FadingText style={[styles.note, { color: theme.ink2 }]}>{used.map((each) => `${KINDS[each.kind]} ${amount(measure, each)}`).join(" · ")}</FadingText>
                </View>
              </View>
            </Animated.View>
          ))}
        </>
      ) : null}
    </Section>
  );
}

/**
 * The last days as a row of bars, a day to a bar, the tallest the day that
 * used most. Over them is what all the days used. Pressing a bar picks its
 * day, which shows what that day used in place of the total, and pressing it
 * again lets the day go.
 */
function Days({ days, measure }: { days: Day[]; measure: Measure }) {
  const theme = useTheme();
  const [picked, setPicked] = useState<string | null>(null);
  const most = Math.max(...days.map((day) => day[measure]));
  const shown = days.find((day) => day.day === picked);
  return (
    <View style={styles.row}>
      <View style={styles.line}>
        <FadingText style={[styles.total, { color: theme.ink }]}>{amount(measure, shown ?? sum(days))}</FadingText>
        <FadingText style={[styles.amount, { color: theme.ink2 }]}>{shown ? dayLabel(dayTime(shown.day)) : `${USAGE_DAYS} days`}</FadingText>
      </View>
      <View style={styles.days}>
        {days.map((day) => (
          <DayBar
            key={day.day}
            day={day}
            measure={measure}
            part={most ? day[measure] / most : 0}
            picked={day === shown}
            faded={shown !== undefined && day !== shown}
            onPress={() => setPicked(day === shown ? null : day.day)}
          />
        ))}
      </View>
    </View>
  );
}

/** One day's bar over the day's name, as tall as the day's part of the day that used most. A day that used nothing has a mark where its bar would stand. */
function DayBar({ day, measure, part, picked, faded, onPress }: { day: Day; measure: Measure; part: number; picked: boolean; faded: boolean; onPress: () => void }) {
  const theme = useTheme();
  const time = dayTime(day.day);
  const bar = useAnimatedStyle(() => ({ height: withTiming(Math.max(part * BAR_HEIGHT, BAR_LEAST), EASE), opacity: withTiming(faded ? FADED : 1, EASE) }));
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${dayLabel(time)}, ${amount(measure, day)}`} accessibilityState={{ selected: picked }} style={styles.day}>
      <View style={styles.barSpace}>
        <Animated.View style={[styles.bar, { backgroundColor: part ? theme.tint : theme.line }, bar]} />
      </View>
      <Text numberOfLines={1} style={[styles.dayName, { color: picked ? theme.ink : theme.ink2 }]}>
        {new Date(time).toLocaleDateString(undefined, { weekday: "short" })}
      </Text>
    </Pressable>
  );
}

// How tall the bar of the day that used most stands, and the mark of a day that used nothing.
const BAR_HEIGHT = 96;
const BAR_LEAST = 2;
// How much of a bar shows while another day is picked.
const FADED = 0.35;

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  page: { paddingHorizontal: 20 },
  // Done stays at the sheet's top while the page scrolls under it.
  done: { alignSelf: "flex-end", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  doneText: { fontSize: 17, fontWeight: "600" },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: 0.2 },
  failure: { fontSize: 15, lineHeight: 20, marginTop: 24, paddingHorizontal: 4 },
  row: { gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  agent: { flexDirection: "row", alignItems: "center", gap: 12 },
  agentText: { flex: 1, gap: 8 },
  line: { flexDirection: "row", alignItems: "baseline", gap: 12 },
  total: { flex: 1, fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"] },
  days: { flexDirection: "row", gap: 6, marginTop: 4 },
  day: { flex: 1, gap: 6 },
  barSpace: { height: BAR_HEIGHT, justifyContent: "flex-end" },
  bar: { borderRadius: 4, borderCurve: "continuous" },
  dayName: { fontSize: 12, textAlign: "center" },
  name: { flex: 1, fontSize: 16, lineHeight: 21 },
  amount: { fontSize: 15, lineHeight: 21, fontVariant: ["tabular-nums"] },
  note: { fontSize: 14, lineHeight: 19 },
});
