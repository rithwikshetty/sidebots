import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { PROVIDERS, USAGE_DAYS, type Limit, type Usage } from "@server/contract";
import { AvatarView } from "@/components/AvatarView";
import { Bar } from "@/components/Bar";
import { FadingText } from "@/components/FadingText";
import { Rule, Section } from "@/components/Section";
import { ApiError, UPDATE } from "@/lib/api";
import { HIDE, MOVE, SHOW } from "@/lib/motion";
import { loadUsage, useAgents, useUsage } from "@/lib/state";
import { useTheme } from "@/lib/theme";
import { listTime, nextTime } from "@/lib/time";
import { COST_NOTE, KINDS, dollars, usedBy } from "@/lib/usage";

/**
 * Where the person's plan or API credit goes, opened from the side menu.
 * First, for each provider their agents sign in to with a plan, how much of
 * each of the plan's limits is left and when it resets, as the provider said
 * while an agent last ran. Then the agents that ran a turn in the last days,
 * the one that used most first, each with its share of what all of them used
 * and how that splits between its replies, its jobs and its fresh starts. It
 * opens on what the phone last had, and what the computer then says fades in.
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
              <Agents usage={usage} />
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
          ? `As ${name} said when an agent last ran, ${listTime(said)}. It counts what you use outside Sidebots too.`
          : `${name} says how much of your plan is left as an agent runs. It hasn't yet.`
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

/** The agents that ran a turn in the last days, the one that used most first. */
function Agents({ usage }: { usage: Usage }) {
  const theme = useTheme();
  const rows = useAgents()
    .map((agent) => ({ agent, used: usedBy(usage, agent.id) }))
    .filter(({ used }) => used.length)
    .map((row) => ({ ...row, cost: row.used.reduce((sum, each) => sum + each.cost, 0) }))
    .sort((a, b) => b.cost - a.cost);
  const all = rows.reduce((sum, row) => sum + row.cost, 0);
  return (
    <Section title={`Last ${USAGE_DAYS} days`} note={rows.length ? COST_NOTE : "No agent has run a turn."}>
      {rows.map(({ agent, used, cost }, index) => (
        <Animated.View key={agent.id} entering={SHOW} exiting={HIDE} layout={MOVE}>
          {index > 0 ? <Rule /> : null}
          <View style={[styles.row, styles.agent]}>
            <AvatarView avatarId={agent.avatar_id} state="resting" size={40} />
            <View style={styles.agentText}>
              <View style={styles.line}>
                <Text numberOfLines={1} style={[styles.name, { color: theme.ink }]}>
                  {agent.name}
                </Text>
                <FadingText style={[styles.amount, { color: theme.ink2 }]}>{dollars(cost)}</FadingText>
              </View>
              <Bar part={all ? cost / all : 0} label={`${agent.name}'s share`} />
              <FadingText style={[styles.note, { color: theme.ink2 }]}>{used.map((each) => `${KINDS[each.kind]} ${dollars(each.cost)}`).join(" · ")}</FadingText>
            </View>
          </View>
        </Animated.View>
      ))}
    </Section>
  );
}

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
  name: { flex: 1, fontSize: 16, lineHeight: 21 },
  amount: { fontSize: 15, lineHeight: 21, fontVariant: ["tabular-nums"] },
  note: { fontSize: 14, lineHeight: 19 },
});
