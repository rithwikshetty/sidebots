// Notifications. The server sends one through Apple's push service when an
// agent replies or a turn fails. The app says whether they may come, which
// phone takes them, and what a tap on one opens. They are for when the person
// is away: while the app is open none shows or sounds, and the chat list
// carries the unread counts.

import { useEffect } from "react";
import { AppState } from "react-native";
import * as Application from "expo-application";
import { isDevice } from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import type { PushToken } from "@server/contract";
import { isPaired, request } from "./api";
import { useAgents } from "./state";

// The chat on screen, which a tapped notification for it has no need to open.
let chatOnScreen: string | null = null;
const SILENT = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };

/** The agent a notification is about, which the server sends as its data. */
function agentOf(notification: Notifications.Notification): string | null {
  const agentId = notification.request.content.data?.agent_id;
  return typeof agentId === "string" ? agentId : null;
}

/**
 * Which of Apple's push services issued this install's token. A build signed
 * for development names the sandbox in its provisioning profile. TestFlight
 * and the App Store remove the profile, so a phone without one is on
 * production. The simulator has none either and uses the sandbox.
 */
async function environment(): Promise<PushToken["environment"]> {
  const named = await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null);
  return named === "development" || (named === null && !isDevice) ? "sandbox" : "production";
}

/** Gives the server this phone's token when the phone allows notifications. */
async function register(): Promise<void> {
  if (!isPaired() || (await Notifications.getPermissionsAsync()).status !== "granted") return;
  const token = (await Notifications.getDevicePushTokenAsync()).data;
  if (typeof token !== "string") return;
  const push: PushToken = { token, environment: await environment() };
  await request("/push-token", { method: "PUT", body: push });
}

/**
 * Asks the phone once whether Sidebots may notify the person. The chat calls it
 * when they have just sent a message and may leave while the agent works.
 */
export async function askForPush(): Promise<void> {
  const { status, canAskAgain } = await Notifications.getPermissionsAsync();
  if (status === "granted" || !canAskAgain) return;
  const answer = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: true } });
  if (answer.status === "granted") await register();
}

/** Marks a chat as the one on screen until the returned release runs, and clears its notifications from the phone. */
export function showChatOnScreen(agentId: string): () => void {
  chatOnScreen = agentId;
  void Notifications.getPresentedNotificationsAsync()
    .then((presented) =>
      Promise.all(
        presented.filter((notification) => agentOf(notification) === agentId).map((notification) => Notifications.dismissNotificationAsync(notification.request.identifier)),
      ),
    )
    .catch(() => undefined);
  return () => {
    if (chatOnScreen === agentId) chatOnScreen = null;
  };
}

/**
 * The app's side of notifications, kept by the home screen: none shows while
 * the app is open, the app's icon carries the number of unread messages, the
 * phone's token is kept with the server and sent again on each return to the
 * app, and a tapped notification opens its chat.
 */
export function usePush(): void {
  const unread = useAgents().reduce((total, agent) => total + (agent.muted ? 0 : agent.unread), 0);
  useEffect(() => {
    void Notifications.setBadgeCountAsync(unread).catch(() => undefined);
  }, [unread]);

  useEffect(() => {
    Notifications.setNotificationHandler({ handleNotification: async () => SILENT });

    const sync = () => void register().catch(() => undefined);
    sync();
    const active = AppState.addEventListener("change", (next) => next === "active" && sync());

    const open = (response: Notifications.NotificationResponse | null) => {
      const agentId = response && agentOf(response.notification);
      if (!agentId || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      Notifications.clearLastNotificationResponse();
      if (agentId === chatOnScreen) return;
      // From another chat the new one takes its place, so Back still goes home.
      if (chatOnScreen) router.replace(`/chat/${agentId}`);
      else router.push(`/chat/${agentId}`);
    };
    // The tap that opened the app, then every tap after.
    open(Notifications.getLastNotificationResponse());
    const taps = Notifications.addNotificationResponseReceivedListener(open);

    return () => {
      active.remove();
      taps.remove();
    };
  }, []);
}
