import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ellipsis, Menu } from "lucide-react-native";
import type { AvatarState } from "@server/contract";
import { Glass } from "@/components/Glass";
import { AvatarView } from "@/components/AvatarView";
import { EdgeFade } from "@/components/EdgeFade";
import { useWindowControls } from "@/lib/layout";
import { POP_IN, POP_OUT } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { MessageMenuView, type MessageMenuAction } from "../../modules/message-menu/src";

/** The height of the bar the menu button and the avatar sit in, under the status bar. */
export const BAR_HEIGHT = 44;
/** How far the avatar's name reaches below the bar, which the chat clears. */
export const HEADER_OVERHANG = 14;
/** The room the messages leave below the header. */
export const HEADER_CLEARANCE = 16;

const AVATAR = 40;
const BAR_BUTTON = 44;
const BAR_INSET = 16;
// The unread count keeps its size, and its text fits it up to this text size.
const COUNT_MAX_SCALE = 1.3;

/** What the chat's menu offers. The image is one of the system's symbols. */
const MENU_ACTIONS: MessageMenuAction[] = [
  { id: "fresh-start", title: "Fresh start", subtitle: "Clears what the agent has in mind. Your chat and its memory stay.", systemImage: "sparkles" },
];

/**
 * The top of a chat, as Messages draws a conversation's: no bar, only
 * floating parts. A glass button at the left opens the side menu, given
 * `onMenu`, which a chat beside the agents' column has no need of. It
 * carries the count of what the person's other agents sent that is `unread`.
 * The agent's avatar in the
 * middle with its name in a glass pill under it, which a tap opens the
 * agent's page from, and a glass button at the right that opens the chat's menu. Behind them the screen fades from the
 * page colour, so messages scrolling up pass softly under them.
 */
export function ChatHeader({ name, avatarId, avatarState, dimmed, unread = 0, onMenu, onAbout, onFreshStart }: {
  name: string;
  avatarId: string;
  avatarState: AvatarState;
  dimmed: boolean;
  unread?: number;
  onMenu?: () => void;
  onAbout: () => void;
  onFreshStart: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const controls = useWindowControls();
  const height = insets.top + BAR_HEIGHT + HEADER_OVERHANG + HEADER_CLEARANCE;
  return (
    <>
      <EdgeFade edge="top" height={height} solid={insets.top} />
      {onMenu ? (
        <Pressable
          onPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel={unread ? `Agents, ${unread} unread` : "Agents"}
          style={[styles.menu, { top: insets.top + (BAR_HEIGHT - BAR_BUTTON) / 2, marginLeft: controls }]}>
          <Glass interactive style={styles.glass}>
            <Menu size={24} strokeWidth={2.25} color={theme.tintInk} />
          </Glass>
          {unread ? (
            <Animated.View entering={POP_IN} exiting={POP_OUT} pointerEvents="none" style={[styles.count, { backgroundColor: theme.tint }]}>
              <Text maxFontSizeMultiplier={COUNT_MAX_SCALE} style={[styles.countText, { color: theme.onTint }]}>
                {unread > 99 ? "99+" : unread}
              </Text>
            </Animated.View>
          ) : null}
        </Pressable>
      ) : null}
      {/* The native menu button over the glass takes the tap and reads to VoiceOver. */}
      <MessageMenuView
        actions={MENU_ACTIONS}
        opensOnTap
        label="Chat menu"
        onAction={({ nativeEvent }) => nativeEvent.id === "fresh-start" && onFreshStart()}
        style={[styles.more, { top: insets.top + (BAR_HEIGHT - BAR_BUTTON) / 2 }]}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
          <Glass style={styles.glass}>
            <Ellipsis size={22} strokeWidth={2.25} color={theme.tintInk} />
          </Glass>
        </View>
      </MessageMenuView>
      <View pointerEvents="box-none" style={[styles.header, { top: insets.top }]}>
        <Pressable onPress={onAbout} accessibilityRole="button" accessibilityLabel={`About ${name}`} hitSlop={6}>
          <Named name={name} interactive>
            <AvatarView avatarId={avatarId} state={avatarState} size={AVATAR} dimmed={dimmed} />
          </Named>
        </Pressable>
      </View>
    </>
  );
}

/**
 * Who a header is for: the avatars, in a row, with the name in a glass pill
 * under them. The pill of one that a tap opens is `interactive`.
 */
export function Named({ name, interactive = false, children }: { name: string; interactive?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.about}>
      <View style={styles.avatar}>{children}</View>
      <Glass interactive={interactive} style={styles.pill}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.ink }]}>
          {name}
        </Text>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  menu: { position: "absolute", left: BAR_INSET, zIndex: 3 },
  count: { position: "absolute", top: -4, right: -6, minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 7, alignItems: "center", justifyContent: "center" },
  countText: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  more: { position: "absolute", right: BAR_INSET, zIndex: 3 },
  glass: { width: BAR_BUTTON, height: BAR_BUTTON, borderRadius: BAR_BUTTON / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  header: { position: "absolute", left: 0, right: 0, alignItems: "center", paddingTop: 2, zIndex: 2 },
  about: { alignItems: "center" },
  avatar: { flexDirection: "row", alignItems: "center", gap: 7, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  pill: {
    marginTop: -5,
    paddingHorizontal: 11,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
    maxWidth: 220,
  },
  name: { fontWeight: "600", fontSize: 12, lineHeight: 16 },
});
