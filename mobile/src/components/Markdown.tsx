import { useMemo } from "react";
import { Linking, StyleSheet } from "react-native";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";
import * as WebBrowser from "expo-web-browser";
import { type Theme, useTheme } from "@/lib/theme";

const FONT_SIZE = 17;
const LINE_HEIGHT = 22;
const CODE_FONT = "Menlo";

/**
 * An agent's reply as rich text, as T3 Code draws one: GitHub's markdown,
 * with headings, lists, task lists, quotes, tables, highlighted code and
 * links. The text is selectable with the system's own menu. A web link opens
 * in a Safari sheet over the app; any other link, such as a phone number or
 * an email address, goes to the app that handles it.
 */
export function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  const markdownStyle = useMemo(() => styleFor(theme), [theme]);
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

async function openLink(url: string, theme: Theme): Promise<void> {
  if (/^https?:\/\//i.test(url)) {
    await WebBrowser.openBrowserAsync(url, { controlsColor: theme.tintInk, presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET }).catch(() => undefined);
  } else {
    await Linking.openURL(url).catch(() => undefined);
  }
}

/** The reply's look, from the chat's own sizes and colours, on the grey of the agent's bubble. */
function styleFor(theme: Theme): MarkdownStyle {
  const text = { fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, color: theme.ink };
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
    // Code sits on the page colour, so it stands out from the bubble's grey in both modes.
    codeBlock: {
      fontFamily: CODE_FONT,
      fontSize: 14,
      lineHeight: 20,
      color: theme.ink,
      backgroundColor: theme.bg,
      borderColor: theme.line,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 12,
      padding: 12,
      marginBottom: 10,
    },
    code: { fontFamily: CODE_FONT, fontSize: 15, color: theme.ink, backgroundColor: theme.bg, borderColor: theme.line },
    link: { color: theme.tintInk, underline: true },
    strong: { fontWeight: "bold" },
    table: {
      fontSize: 15,
      lineHeight: 20,
      color: theme.ink,
      headerBackgroundColor: theme.bg,
      headerTextColor: theme.ink,
      rowEvenBackgroundColor: theme.bubble,
      rowOddBackgroundColor: theme.bubble,
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
