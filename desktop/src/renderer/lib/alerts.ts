import type { Agent, Connected, Job } from "@server/contract.ts";
import { deleteConfirmation, deleteJobConfirmation, removeConnectionConfirmation } from "@client/confirmations.ts";
import { confirm } from "../ui/Confirm.tsx";
import { showToast } from "../ui/Toast.tsx";
import { changeAgent, deleteAgent, removeConnection, removeJob, type AgentChanges } from "./store.ts";

/** Tells the person something didn't work, with the reason when there is one, in a toast. */
export function problem(title: string, failure: unknown): void {
  showToast({ title, description: failure instanceof Error ? failure.message : "Something went wrong.", problem: true });
}

/** Changes an agent, and tells the person in a toast when that didn't work. */
export function changeOrSay(agentId: string, changes: AgentChanges): void {
  changeAgent(agentId, changes).catch((failure) => problem("Couldn't change that", failure));
}

/** Asks before deleting an agent, since nothing of it can be brought back. Its chat closes once it is gone. */
export async function confirmDelete(agent: Agent): Promise<void> {
  const { title, message, action, failed } = deleteConfirmation(agent);
  if (await confirm({ title, message, action, destructive: true })) await deleteAgent(agent.id).catch((failure) => problem(failed, failure));
}

/** Asks before deleting a job, since it stops running and can't be brought back. */
export async function confirmDeleteJob(job: Job): Promise<void> {
  const { title, message, action, failed } = deleteJobConfirmation(job);
  if (await confirm({ title, message, action, destructive: true })) await removeJob(job.agent_id, job.id).catch((failure) => problem(failed, failure));
}

/** Asks before removing a connection, since every agent loses it until the person signs in to it again. */
export async function confirmRemoveConnection(connected: Connected): Promise<void> {
  const { title, message, action, failed } = removeConnectionConfirmation(connected);
  if (await confirm({ title, message, action, destructive: true })) await removeConnection(connected).catch((failure) => problem(failed, failure));
}
