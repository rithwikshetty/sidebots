import type { Agent, Connected, Job } from "../server/src/contract.ts";

/** What an app asks before it does something that can't be undone: the question, what is lost, the word on the button that goes ahead, and what to say when going ahead fails. */
export type Confirmation = { title: string; message: string; action: string; failed: string };

/** Asked before deleting an agent, since nothing of it can be brought back. */
export function deleteConfirmation(agent: Agent): Confirmation {
  return { title: `Delete ${agent.name}?`, message: "Its chat, its memory, its jobs and its files are removed for good.", action: "Delete", failed: "Couldn't delete it" };
}

/** Asked before deleting a job, since it stops running and can't be brought back. */
export function deleteJobConfirmation(job: Job): Confirmation {
  return { title: `Delete "${job.title}"?`, message: "It stops running, and this can't be undone.", action: "Delete", failed: "Couldn't delete it" };
}

/** Asked before removing a connection, since every agent loses it until the person signs in to it again. */
export function removeConnectionConfirmation(connected: Connected): Confirmation {
  return { title: `Remove ${connected.name}?`, message: "None of your agents can use it until you connect it again.", action: "Remove", failed: "Couldn't remove it" };
}
