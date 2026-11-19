import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, Ellipsis } from "lucide-react-native";
import type { AvatarState } from "@server/contract";
import { Glass } from "@/components/Glass";
import { AvatarView } from "@/components/AvatarView";
import { EdgeFade } from "@/components/EdgeFade";
import { useWindowControls } from "@/lib/layout";
import { useTheme } from "@/lib/theme";
import { MessageMenuView, type MessageMenuAction } from "../../modules/message-menu/src";

/** The height of the bar the back button and the avatar sit in, under the status bar. */
export const BAR_HEIGHT = 44;
/** How far the avatar's name reaches below the bar, which the chat clears. */
export const HEADER_OVERHANG = 14;
/** The room the messages leave below the header. */
export const HEADER_CLEARANCE = 16;

const AVATAR = 40;
const BAR_BUTTON = 44;
const BAR_INSET = 16;

/** What the chat's menu offers. The image is one of the system's symbols. */
const MENU_ACTIONS: MessageMenuAction[] = [
  { id: "fresh-start", title: "Fresh start", subtitle: "Clears what the agent has in mind. Your chat and its memory stay.", systemImage: "sparkles" },
];

/**
 * The top of a chat, as Messages draws a conversation's: no bar, only
 * floating parts. A glass back button at the left, given `onBack`, which a
 * chat beside the agents' column has no need of. The agent's avatar in the
 * middle with its name in a glass pill under it, which a tap opens the
 * agent's page from, and a glass button at the right that opens the chat's menu. Behind them the screen fades from the
 * page colour, so messages scrolling up pass softly under them.
 */
export function ChatHeader({ name, avatarId, avatarState, dimmed, onBack, onAbout, onFreshStart }: {
  name: string;
  avatarId: string;
  avatarState: AvatarState;
  dimmed: boolean;
  onBack?: () => void;
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
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={[styles.back, { top: insets.top + (BAR_HEIGHT - BAR_BUTTON) / 2, marginLeft: controls }]}>
          <Glass interactive style={styles.glass}>
            <ChevronLeft size={24} strokeWidth={2.25} color={theme.tintInk} />
          </Glass>
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
        <Pressable onPress={onAbout} accessibilityRole="button" accessibilityLabel={`About ${name}`} hitSlop={6} style={styles.about}>
          <View style={styles.avatar}>
            <AvatarView avatarId={avatarId} state={avatarState} size={AVATAR} dimmed={dimmed} />
          </View>
          <Glass interactive style={styles.pill}>
            <Text numberOfLines={1} style={[styles.name, { color: theme.ink }]}>
              {name}
            </Text>
          </Glass>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  back: { position: "absolute", left: BAR_INSET, zIndex: 3 },
  more: { position: "absolute", right: BAR_INSET, zIndex: 3 },
  glass: { width: BAR_BUTTON, height: BAR_BUTTON, borderRadius: BAR_BUTTON / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  header: { position: "absolute", left: 0, right: 0, alignItems: "center", paddingTop: 2, zIndex: 2 },
  about: { alignItems: "center" },
  avatar: { shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
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
