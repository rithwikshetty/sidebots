// Live Activities. While an agent works, its avatar shows on the Lock Screen
// and in the Dynamic Island with its name, as the widget in targets/activity
// draws it. The app starts the activity while it is in front, with the
// agent's name and its avatar's pictures, so they never leave the phone. It
// gives the computer the token Apple takes the activity's updates under, and
// the computer ends the activity by push when the work does: on the avatar's
// replied or failed pose, which stays on the Lock Screen a while. That reaches
// a phone that is locked, with the app closed.

import { useEffect } from "react";
import { AppState } from "react-native";
import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { AVATAR_SHEET, AVATAR_STATES, avatarFrame, type AgentWithLatest, type AvatarState } from "@server/contract";
import { AgentActivity } from "../../modules/agent-activity/src";
import { avatarSheet, isPaired, onPairing, request } from "./api";
import { workingLine } from "./lines";
import { pushTokenOf } from "./push";
import { onAgents } from "./state";

// The states an activity shows: working, then the one the work ends on.
const SHOWN: AvatarState[] = ["working", "replied", "failed"];
const POSES = Object.fromEntries(
  SHOWN.map((state) => {
    const { x, y, width, height } = avatarFrame(state, AVATAR_STATES[state].still);
    return [state, [x, y, width, height]];
  }),
) as Record<string, [number, number, number, number]>;

// The agents whose activity is on its way to the screen.
const starting = new Set<string>();

async function start(agent: AgentWithLatest): Promise<void> {
  // The sheet is on the phone from the first time the app heard of the avatar. Until it is, the agent goes without an activity.
  const sheet = await Image.getCachePathAsync(avatarSheet(agent.avatar_id).uri);
  if (!sheet) return;
  await AgentActivity.start({
    agentId: agent.id,
    name: agent.name,
    url: Linking.createURL(`/chat/${agent.id}`),
    lines: { working: workingLine(), replied: "Replied", failed: "Couldn't finish" },
    sheet,
    poses: POSES,
    pixel: AVATAR_SHEET.art.pixel,
  });
}

/**
 * Starts an activity for each agent that works and has none, and takes away
 * the ones whose agent has stopped, is muted or is gone. `agents` are as the
 * computer just said they are. It waits for the app to be in front: iOS starts
 * an activity only then, and an activity the computer ended while the person
 * was away keeps its last pose on the Lock Screen until they are back.
 */
function show(agents: AgentWithLatest[]): void {
  if (AppState.currentState !== "active" || !AgentActivity.isAvailable()) return;
  const working = agents.filter((agent) => agent.working && !agent.muted);
  const shown = AgentActivity.shown();
  for (const { agentId } of shown) {
    if (!working.some((agent) => agent.id === agentId)) void AgentActivity.end(agentId);
  }
  for (const agent of working) {
    if (starting.has(agent.id) || shown.some((each) => each.agentId === agent.id && each.live)) continue;
    starting.add(agent.id);
    void start(agent)
      .catch(() => undefined)
      .finally(() => starting.delete(agent.id));
  }
}

/**
 * The app's side of Live Activities, kept by the home screen: working agents
 * show as activities, and the computer gets each activity's token. An
 * activity whose token the computer doesn't take could never be ended from
 * there, so the app ends it. That covers a computer too old to know of
 * activities, one out of reach, and an agent that finished before the token
 * came.
 */
export function useActivities(): void {
  useEffect(() => {
    const tokens = AgentActivity.addListener("onToken", ({ agentId, token }) => {
      void pushTokenOf(token)
        .then((push) => request(`/agents/${agentId}/activity-token`, { method: "PUT", body: push }))
        .catch(() => AgentActivity.end(agentId));
    });
    const agents = onAgents(show);
    // A phone that has left its computer shows none of its agents.
    const pairing = onPairing(() => {
      if (!isPaired()) show([]);
    });
    return () => {
      tokens.remove();
      agents();
      pairing();
    };
  }, []);
}
