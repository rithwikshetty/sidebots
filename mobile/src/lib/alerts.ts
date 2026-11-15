import { Alert } from "react-native";
import type { Agent } from "@server/contract";
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
