import { useEffect, useRef, useState } from "react";
import { PixelRatio, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance, type TextStyle } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig, LinearTransition, useAnimatedStyle, useReducedMotion, withTiming } from "react-native-reanimated";
import { ArrowUp, Mic, Plus } from "lucide-react-native";
import { MessageMenuView, type MessageMenuAction } from "../../modules/message-menu/src";
import { AttachmentTray, TRAY_HEIGHT, TRAY_TILE_EXIT_MS } from "@/components/AttachmentTray";
import { BUTTONS_ENTERING, BUTTONS_EXITING, DICTATION_ENTERING, DICTATION_EXITING, DictationBar, useFlipAway } from "@/components/DictationBar";
import { Glass } from "@/components/Glass";
import { IconButton } from "@/components/IconButton";
import { canDictate, useDictation } from "@/lib/dictation";
import type { Picked, PickSource } from "@/lib/files";
import { EASE } from "@/lib/motion";
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
// The bottom right holds Send, with the microphone before it on a phone that can dictate.
const TRAILING = canDictate ? BUTTON * 2 + 4 : BUTTON;
// Where the text sits in each shape. At rest it shares one line with the
// buttons; while typing it fills the card above them.
const TEXT_FRAME = {
  resting: { left: INSET + BUTTON + 4, right: INSET + TRAILING + 6, top: INSET },
  typing: { left: 16, right: 16, top: 16 },
};
const TRANSITION = LinearTransition.duration(220);
// The tray sits at the card's top, its tiles' remove targets reaching to the
// card's edge, with the text below it.
const TRAY_SPACE = TRAY_HEIGHT;

const ATTACH_ACTIONS: (MessageMenuAction & { id: PickSource })[] = [
  { id: "photos", title: "Photos", systemImage: "photo.on.rectangle" },
  { id: "camera", title: "Camera", systemImage: "camera" },
  { id: "files", title: "Files", systemImage: "folder" },
];

/**
 * The message field, as Assist's: + at the bottom left, which opens a menu
 * of Photos, Camera and Files, and the round Send at the bottom right, with
 * the microphone before it on iOS 26 and later. At rest it is one slim line
 * between the buttons. While the person types, or once something is
 * attached, it opens into a card with the text above the buttons, growing
 * with the text up to about six lines, then scrolling; picked photos and
 * files sit in a tray above the text. A message can go with only photos or
 * files. A tap on the microphone turns the buttons away for the dictation
 * row, whose ✓ adds what the person said to the end of the text. The card is
 * glass, so messages scrolling behind it show through.
 */
export function Composer({
  value,
  onChangeText,
  onSend,
  placeholder,
  attachments,
  onAttach,
  onRemoveAttachment,
  attachDisabled = false,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  placeholder: string;
  attachments: readonly Picked[];
  /** Opens a picker from the + menu; settles once the picks are in the tray. */
  onAttach: (source: PickSource) => Promise<void>;
  onRemoveAttachment: (file: Picked) => void;
  /** The + rests, as once the message holds as many files as it can. */
  attachDisabled?: boolean;
}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const inputRef = useRef<TextInputInstance>(null);
  const [typing, setTyping] = useState(false);
  // The tray keeps its room until its last tile has faded out, then the card
  // closes over it with its own transition, so the text never runs under a
  // tile that is still going.
  const [hasTray, setHasTray] = useState(attachments.length > 0);
  if (attachments.length > 0 && !hasTray) setHasTray(true);
  useEffect(() => {
    if (attachments.length > 0 || !hasTray) return;
    const timer = setTimeout(() => setHasTray(false), reduceMotion ? 0 : TRAY_TILE_EXIT_MS);
    return () => clearTimeout(timer);
  }, [attachments.length, hasTray, reduceMotion]);
  const open = typing || hasTray;
  // An invisible copy of the text, laid out at the text's width, gives the field its height.
  const [contentHeight, setContentHeight] = useState(0);
  // The field's font as this phone draws it, which says where its capitals sit.
  const [font, setFont] = useState<LineFont | null>(null);
  const lineHeight = LINE_HEIGHT * Math.min(PixelRatio.getFontScale(), FIELD_MAX_SCALE);
  const maxHeight = lineHeight * MAX_LINES;
  const canSend = value.trim().length > 0 || attachments.length > 0;
  // Send brightens as there comes to be something to send, and dims as the field empties.
  const sendStyle = useAnimatedStyle(() => ({ opacity: withTiming(canSend ? 1 : 0.4, EASE) }));
  const dictation = useDictation();
  const dictating = dictation.state !== "idle";
  // At rest the line of text shares the row the dictation row takes, so it turns away with the buttons.
  const textAway = useFlipAway(dictating && !open);
  // The words land after whatever the person typed while they were being made.
  const latestValue = useRef(value);
  useEffect(() => {
    latestValue.current = value;
  }, [value]);

  const frame = open ? TEXT_FRAME.typing : TEXT_FRAME.resting;
  const textTop = hasTray ? TRAY_SPACE + 10 : frame.top;
  const textHeight = open ? Math.min(Math.max(contentHeight, lineHeight * 2), maxHeight) : BUTTON;
  const fieldHeight = open ? textTop + textHeight + 4 + BUTTON + INSET : BUTTON + INSET * 2;
  const layout = reduceMotion ? undefined : TRANSITION;
  const turn = <T,>(animation: T) => (reduceMotion ? undefined : animation);

  // A picker covers the app and takes the keyboard away while the field
  // still counts itself focused, so asking it to focus again does nothing.
  // Once the picker has gone the field lets go and takes focus back, which
  // brings the keyboard up where the person was typing.
  const attach = (source: PickSource) => {
    const focused = inputRef.current?.isFocused() ?? false;
    void onAttach(source).finally(() => {
      if (!focused) return;
      inputRef.current?.blur();
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  };

  const finishDictating = async () => {
    const words = await dictation.stop();
    if (!words) return;
    const text = latestValue.current;
    onChangeText(text === "" || /\s$/.test(text) ? text + words : `${text} ${words}`);
  };

  return (
    <Animated.View layout={layout} style={[styles.field, { height: fieldHeight }]}>
      <Glass style={[StyleSheet.absoluteFill, styles.surface]} />
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
      <Animated.View layout={layout} style={[styles.textFrame, { left: frame.left, right: frame.right, top: textTop, height: textHeight }]}>
        <Animated.View style={[styles.turning, textAway]} pointerEvents={dictating && !open ? "none" : "auto"}>
          <TextInput
            ref={inputRef}
            value={value}
            onChangeText={onChangeText}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            placeholder={placeholder}
            placeholderTextColor={theme.faint}
            multiline
            scrollEnabled={open && contentHeight > maxHeight}
            style={[styles.text, styles.input, { color: theme.ink }, open ? styles.openLines : restingLine(font, lineHeight)]}
            selectionColor={theme.tintInk}
            maxFontSizeMultiplier={FIELD_MAX_SCALE}
            // iOS reads an empty field's placeholder after its label, so the
            // placeholder names the field until there is text to read.
            accessibilityLabel={value ? placeholder : undefined}
            enablesReturnKeyAutomatically
          />
        </Animated.View>
      </Animated.View>
      {hasTray ? (
        <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(180)} style={styles.tray}>
          <AttachmentTray files={attachments} onRemove={onRemoveAttachment} />
        </Animated.View>
      ) : null}
      {/* Mounted with the field, the row shows without turning; it turns only as dictation starts and ends. */}
      <LayoutAnimationConfig skipEntering>
        {dictating ? (
          <Animated.View entering={turn(DICTATION_ENTERING)} exiting={turn(DICTATION_EXITING)} style={styles.dictation}>
            <DictationBar
              state={dictation.state}
              levels={dictation.levels}
              seconds={dictation.seconds}
              onCancel={dictation.cancel}
              onConfirm={() => void finishDictating()}
            />
          </Animated.View>
        ) : (
          <>
            <Animated.View entering={turn(BUTTONS_ENTERING)} exiting={turn(BUTTONS_EXITING)} style={[styles.corner, styles.leading]}>
              {/* The native menu button over the + takes the tap and reads to VoiceOver. */}
              <MessageMenuView
                actions={attachDisabled ? [] : ATTACH_ACTIONS}
                opensOnTap
                label="Add photos and files"
                onAction={({ nativeEvent }) => attach(nativeEvent.id as PickSource)}
                style={styles.attach}>
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ opacity: attachDisabled ? 0.35 : 1 }}>
                  <IconButton icon={Plus} label="Add photos and files" iconSize={19} color={theme.ink2} onPress={() => undefined} />
                </View>
              </MessageMenuView>
            </Animated.View>
            <Animated.View entering={turn(BUTTONS_ENTERING)} exiting={turn(BUTTONS_EXITING)} style={[styles.corner, styles.trailing]}>
              {canDictate ? <IconButton icon={Mic} label="Dictate" iconSize={19} color={theme.ink2} onPress={() => void dictation.start()} /> : null}
              <Animated.View style={sendStyle}>
                <Pressable
                  onPress={() => canSend && onSend()}
                  disabled={!canSend}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  accessibilityState={{ disabled: !canSend }}
                  hitSlop={8}
                  style={({ pressed }) => [styles.round, { backgroundColor: theme.tint, opacity: pressed ? 0.75 : 1 }]}>
                  <ArrowUp size={18} strokeWidth={2.5} color={theme.onTint} />
                </Pressable>
              </Animated.View>
            </Animated.View>
          </>
        )}
      </LayoutAnimationConfig>
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
  field: { borderRadius: RADIUS, borderCurve: "continuous", overflow: "hidden" },
  surface: { borderRadius: RADIUS, borderCurve: "continuous" },
  measure: { position: "absolute", top: 0, opacity: 0 },
  text: { includeFontPadding: false, fontWeight: "400", fontSize: FONT_SIZE },
  textFrame: { position: "absolute" },
  tray: { position: "absolute", top: 0, left: 0, right: 0 },
  input: { flex: 1, padding: 0, paddingBottom: 0 },
  turning: { flex: 1 },
  // Open, the lines start at the top; Android's field centres them unless told.
  openLines: { paddingTop: 0, textAlignVertical: "top" },
  corner: { position: "absolute", bottom: INSET, flexDirection: "row", alignItems: "center" },
  leading: { left: INSET },
  // The + takes a full 44pt tap around its 36pt button, reaching past it into the card's edge.
  attach: { width: 44, height: 44, margin: -4, alignItems: "center", justifyContent: "center" },
  trailing: { right: INSET, gap: 4 },
  dictation: { position: "absolute", left: INSET, right: INSET, bottom: INSET },
  round: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: "center", justifyContent: "center" },
});
