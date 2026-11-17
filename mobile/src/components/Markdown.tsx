import { useMemo } from "react";
import { StyleSheet } from "react-native";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";
import { openLink } from "@/lib/links";
import { type Theme, useTheme } from "@/lib/theme";

const FONT_SIZE = 17;
const LINE_HEIGHT = 22;
const CODE_FONT = "Menlo";

/**
 * An agent's reply as rich text, as T3 Code draws one: GitHub's markdown,
 * with headings, lists, task lists, quotes, tables, highlighted code and
 * links. The text is selectable with the system's own menu. A web link opens
 * in a Safari sheet over the app; any other link, such as a phone number or
 * an email address, goes to the app that handles it. `on` is what the text
 * sits on: the agent's chat bubble, or the page, as in a note the agent wrote.
 */
export function Markdown({ text, on = "bubble" }: { text: string; on?: Backdrop }) {
  const theme = useTheme();
  const markdownStyle = useMemo(() => styleFor(theme, on), [theme, on]);
  return (
    <EnrichedMarkdownText
      markdown={text}
      flavor="github"
      markdownStyle={markdownStyle}
      selectionColor={theme.tintInk}
      onLinkPress={({ url }) => void openLink(url, theme)}
    />
  );
}

type Backdrop = "bubble" | "page";

/** The text's look, from the chat's own sizes and colours, on the grey of the agent's bubble or on the page. */
function styleFor(theme: Theme, on: Backdrop): MarkdownStyle {
  const text = { fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, color: theme.ink };
  // Code and a table's header stand out from what the text sits on, in both modes.
  const behind = on === "bubble" ? theme.bubble : theme.bg;
  const apart = on === "bubble" ? theme.bg : theme.field;
  const heading = (fontSize: number, lineHeight: number) => ({ ...text, fontSize, lineHeight, fontWeight: "700", marginTop: 4, marginBottom: 6 });
  return {
    paragraph: { ...text, marginTop: 0, marginBottom: 10 },
    h1: heading(22, 28),
    h2: heading(20, 26),
    h3: heading(18, 24),
    h4: heading(FONT_SIZE, LINE_HEIGHT),
    h5: heading(FONT_SIZE, LINE_HEIGHT),
    h6: heading(FONT_SIZE, LINE_HEIGHT),
    list: { ...text, bulletColor: theme.ink2, markerColor: theme.ink2, gapWidth: 8, marginLeft: 2, itemSpacing: 4, marginBottom: 10 },
    blockquote: { ...text, color: theme.ink2, backgroundColor: "transparent", borderColor: theme.faint, borderWidth: 3, gapWidth: 10, padding: 0, marginBottom: 10 },
    codeBlock: {
      fontFamily: CODE_FONT,
      fontSize: 14,
      lineHeight: 20,
      color: theme.ink,
      backgroundColor: apart,
      borderColor: theme.line,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 12,
      padding: 12,
      marginBottom: 10,
    },
    code: { fontFamily: CODE_FONT, fontSize: 15, color: theme.ink, backgroundColor: apart, borderColor: theme.line },
    link: { color: theme.tintInk, underline: true },
    strong: { fontWeight: "bold" },
    table: {
      fontSize: 15,
      lineHeight: 20,
      color: theme.ink,
      headerBackgroundColor: apart,
      headerTextColor: theme.ink,
      rowEvenBackgroundColor: behind,
      rowOddBackgroundColor: behind,
      borderColor: theme.line,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 6,
      marginBottom: 10,
    },
    taskList: { checkedColor: theme.tint, borderColor: theme.ink2, checkmarkColor: theme.onTint, checkedTextColor: theme.ink2 },
    thematicBreak: { color: theme.line, marginTop: 6, marginBottom: 12 },
  };
}
