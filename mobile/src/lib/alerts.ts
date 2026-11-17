import { Alert } from "react-native";
import type { Agent } from "@server/contract";
import { disconnect } from "./api";
import { deleteAgent } from "./state";

/** Tells the person something didn't work, with the reason when there is one. */
export function problem(title: string, failure: unknown): void {
  Alert.alert(title, failure instanceof Error ? failure.message : "Something went wrong.");
}

/** Asks before deleting an agent, since nothing of it can be brought back. `then` runs once it is gone. */
export function confirmDelete(agent: Agent, then?: () => void): void {
  Alert.alert(`Delete ${agent.name}?`, "Its chat, its memory, its jobs and its files are removed for good.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: () => void deleteAgent(agent.id).then(then, (failure) => problem("Couldn't delete it", failure)),
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
