import { requireNativeView } from "expo";
import type { ReactNode } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

export type MessageMenuAction = {
  id: string;
  title: string;
  /** An SF Symbol name. */
  systemImage?: string;
  /** A second line under the title. */
  subtitle?: string;
  /** Draws a checkmark, as for the choice in effect. */
  checked?: boolean;
  /** Shows without being able to be chosen, as a status. */
  disabled?: boolean;
  /** Draws it in red, as for a Delete. */
  destructive?: boolean;
  /** Opens these as a submenu instead of being chosen itself. */
  children?: MessageMenuAction[];
  /** Consecutive actions with the same group sit together between separators. */
  group?: string;
};

type MessageMenuViewProps = ViewProps & {
  actions: MessageMenuAction[];
  onAction: (event: NativeSyntheticEvent<{ id: string }>) => void;
  /** Open the menu from a tap, as a menu button does, instead of a long press. */
  opensOnTap?: boolean;
  /** What VoiceOver reads for the button a tap-opened menu hangs from. */
  label?: string;
  children?: ReactNode;
};

/**
 * A view whose long press opens the system context menu with `actions`, or,
 * with `opensOnTap`, whose tap opens them as a menu button's menu. The chosen
 * action arrives once the menu has gone, so one that opens a sheet isn't
 * refused by iOS.
 */
export const MessageMenuView = requireNativeView<MessageMenuViewProps>("MessageMenu");
