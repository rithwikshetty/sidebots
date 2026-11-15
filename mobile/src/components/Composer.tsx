import { useState } from "react";
import { PixelRatio, Pressable, StyleSheet, Text, TextInput, View, type TextStyle } from "react-native";
import Animated, { LinearTransition, useReducedMotion } from "react-native-reanimated";
import { ArrowUp, Plus } from "lucide-react-native";
import { useTheme } from "@/lib/theme";

const FONT_SIZE = 16;
// About one line of the system font at 16pt. The field takes the line height
// the font gives it, as a set one sits the text low in an iOS text view.
const LINE_HEIGHT = 19.5;
const MAX_LINES = 6;
const FIELD_MAX_SCALE = 2;
const INSET = 6;
const BUTTON = 36;
const RADIUS = 24;
// Where the text sits in each shape. At rest it shares one line with the
// buttons; while typing it fills the card above them.
const TEXT_FRAME = {
  resting: { left: INSET + BUTTON + 4, right: INSET + BUTTON + 6, top: INSET },
  typing: { left: 16, right: 16, top: 16 },
};
const TRANSITION = LinearTransition.duration(220);

/**
 * The message field, shaped like Assist's: + at the bottom left and the round
 * Send at the bottom right. At rest it is one slim line between the buttons.
 * While the person types it opens into a card with the text above the
 * buttons, growing with the text up to about six lines, then scrolling. The +
 * rests until the app can send photos.
 */
export function Composer({
  value,
  onChangeText,
  onSend,
  placeholder,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  placeholder: string;
}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [typing, setTyping] = useState(false);
  // An invisible copy of the text, laid out at the text's width, gives the field its height.
  const [contentHeight, setContentHeight] = useState(0);
  // The field's font as this phone draws it, which says where its capitals sit.
  const [font, setFont] = useState<LineFont | null>(null);
  const lineHeight = LINE_HEIGHT * Math.min(PixelRatio.getFontScale(), FIELD_MAX_SCALE);
  const maxHeight = lineHeight * MAX_LINES;
  const canSend = value.trim().length > 0;

  const frame = typing ? TEXT_FRAME.typing : TEXT_FRAME.resting;
  const textHeight = typing ? Math.min(Math.max(contentHeight, lineHeight * 2), maxHeight) : BUTTON;
  const fieldHeight = typing ? frame.top + textHeight + 4 + BUTTON + INSET : BUTTON + INSET * 2;
  const layout = reduceMotion ? undefined : TRANSITION;

  return (
    <Animated.View layout={layout} style={[styles.field, { height: fieldHeight, borderColor: theme.line, backgroundColor: theme.card }]}>
      <View
        style={[styles.measure, { left: frame.left, right: frame.right }]}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden>
        <Text
          style={styles.text}
          maxFontSizeMultiplier={FIELD_MAX_SCALE}
          onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
          onTextLayout={(event) => {
            const line = event.nativeEvent.lines[0];
            if (line) {
              setFont((current) =>
                current?.ascender === line.ascender && current.capHeight === line.capHeight ? current : { ascender: line.ascender, capHeight: line.capHeight },
              );
            }
          }}>
          {value}
          {"​"}
        </Text>
      </View>
      <Animated.View layout={layout} style={[styles.textFrame, { left: frame.left, right: frame.right, top: frame.top, height: textHeight }]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          placeholder={placeholder}
          placeholderTextColor={theme.faint}
          multiline
          scrollEnabled={typing && contentHeight > maxHeight}
          style={[styles.text, styles.input, { color: theme.ink }, typing ? styles.openLines : restingLine(font, lineHeight)]}
          selectionColor={theme.tintInk}
          maxFontSizeMultiplier={FIELD_MAX_SCALE}
          accessibilityLabel={value ? placeholder : undefined}
          enablesReturnKeyAutomatically
        />
      </Animated.View>
      <View style={[styles.corner, styles.leading]}>
        <View style={[styles.round, { opacity: 0.35 }]} accessibilityLabel="Add photos and files" accessibilityState={{ disabled: true }}>
          <Plus size={19} strokeWidth={2} color={theme.ink2} />
        </View>
      </View>
      <View style={[styles.corner, styles.trailing]}>
        <Pressable
          onPress={() => canSend && onSend()}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !canSend }}
          hitSlop={8}
          style={({ pressed }) => [styles.round, { backgroundColor: theme.tint, opacity: !canSend ? 0.4 : pressed ? 0.75 : 1 }]}>
          <ArrowUp size={18} strokeWidth={2.5} color={theme.onTint} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

/** Where a font's capitals sit in its line: the baseline's depth from the line's top, and their height. */
type LineFont = { ascender: number; capHeight: number };

/**
 * At rest the one line's capitals sit in the middle of the buttons' row, as
 * the + and Send do. The padding comes from the phone's own font, since a
 * fixed one fits only the font it was measured on. Until the font is
 * measured the line takes half the room it leaves.
 */
function restingLine(font: LineFont | null, lineHeight: number): TextStyle {
  const paddingTop = font ? BUTTON / 2 + font.capHeight / 2 - font.ascender : (BUTTON - lineHeight) / 2;
  return { paddingTop, textAlignVertical: "top" };
}

const styles = StyleSheet.create({
  field: { borderRadius: RADIUS, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  measure: { position: "absolute", top: 0, opacity: 0 },
  text: { includeFontPadding: false, fontWeight: "400", fontSize: FONT_SIZE },
  textFrame: { position: "absolute" },
  input: { flex: 1, padding: 0, paddingBottom: 0 },
  // Open, the lines start at the top; Android's field centres them unless told.
  openLines: { paddingTop: 0, textAlignVertical: "top" },
  corner: { position: "absolute", bottom: INSET, flexDirection: "row", alignItems: "center" },
  leading: { left: INSET },
  trailing: { right: INSET },
  round: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: "center", justifyContent: "center" },
});
