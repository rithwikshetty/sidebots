import { requireNativeModule, type NativeModule } from "expo";

/**
 * What an agent's Live Activity is drawn from. It stays on the phone. `url` is
 * what a tap on the activity opens, and `lines` has the line under the agent's
 * name in each state. `sheet` is the path of the avatar's spritesheet on the
 * phone, `poses` says where each state's picture is in it, as x, y, width and
 * height, and `pixel` is how many of the sheet's pixels make one pixel of the
 * drawing.
 */
export type ShownAgent = {
  agentId: string;
  name: string;
  url: string;
  lines: Record<string, string>;
  sheet: string;
  poses: Record<string, [number, number, number, number]>;
  pixel: number;
};

type Events = {
  /** The token Apple's push service takes an agent's activity's updates under, in hex. It comes a moment after the activity starts, again if Apple changes it, and for an activity already running when the app starts listening. */
  onToken(event: { agentId: string; token: string }): void;
};

declare class AgentActivityModule extends NativeModule<Events> {
  /** Whether the phone shows Live Activities, and the person lets Sidebots show them. */
  isAvailable(): boolean;
  /** The agents with an activity on the phone. `live` is false once the activity has ended and is only waiting to leave the Lock Screen. */
  shown(): { agentId: string; live: boolean }[];
  /** Starts an agent's activity, in its working state, in place of any it had. iOS allows it only while the app is in front. */
  start(agent: ShownAgent): Promise<void>;
  /** Takes an agent's activity off the phone at once. */
  end(agentId: string): Promise<void>;
}

/** The Live Activities that show working agents on the Lock Screen and in the Dynamic Island, one for each agent. */
export const AgentActivity = requireNativeModule<AgentActivityModule>("AgentActivity");
