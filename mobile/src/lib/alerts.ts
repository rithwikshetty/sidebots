import { Alert } from "react-native";
import type { Agent, Connected, Job } from "@server/contract";
import { deleteConfirmation, deleteJobConfirmation, removeConnectionConfirmation } from "@client/confirmations";
import { disconnect } from "./api";
import { deleteAgent, removeConnection, removeJob } from "./state";

/** Tells the person something didn't work, with the reason when there is one. */
export function problem(title: string, failure: unknown): void {
  Alert.alert(title, failure instanceof Error ? failure.message : "Something went wrong.");
}

/** Asks before deleting an agent, since nothing of it can be brought back. Its chat closes once it is gone. */
export function confirmDelete(agent: Agent): void {
  const { title, message, action, failed } = deleteConfirmation(agent);
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: action,
      style: "destructive",
      onPress: () => void deleteAgent(agent.id).catch((failure) => problem(failed, failure)),
    },
  ]);
}

/** Asks before deleting a job, since it stops running and can't be brought back. `onDeleted` is called once it is gone. */
export function confirmDeleteJob(job: Job, onDeleted: () => void): void {
  const { title, message, action, failed } = deleteJobConfirmation(job);
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: action,
      style: "destructive",
      onPress: () => void removeJob(job.agent_id, job.id).then(onDeleted, (failure) => problem(failed, failure)),
    },
  ]);
}

/** Asks before removing a connection, since every agent loses it until the person signs in to it again. */
export function confirmRemoveConnection(connected: Connected): void {
  const { title, message, action, failed } = removeConnectionConfirmation(connected);
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: action,
      style: "destructive",
      onPress: () => void removeConnection(connected).catch((failure) => problem(failed, failure)),
    },
  ]);
}

/**
 * Asks before disconnecting from the computer, since the phone needs a new
 * code to pair again. `machine` is the computer's name. When the computer
 * can't be told, asks whether to disconnect the phone alone.
 */
export function confirmDisconnect(machine: string): void {
  const alone = (failure: unknown) =>
    Alert.alert("Couldn't tell your computer", `${failure instanceof Error ? failure.message : "Something went wrong."} If you disconnect anyway, ${machine} lists this phone until you remove it there.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect anyway", style: "destructive", onPress: () => void disconnect(true) },
    ]);
  Alert.alert(`Disconnect from ${machine}?`, "Your agents and their chats stay on the computer. To reach them from this phone again, pair it with a new code.", [
    { text: "Cancel", style: "cancel" },
    { text: "Disconnect", style: "destructive", onPress: () => void disconnect().catch(alone) },
  ]);
}
