import { Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";
import type { Theme } from "./theme";

/** Opens a link: a web page in a sheet over the app, and anything else, such as an email address, in the app the phone gives it to. */
export async function openLink(url: string, theme: Theme): Promise<void> {
  if (/^https?:\/\//i.test(url)) {
    await WebBrowser.openBrowserAsync(url, { controlsColor: theme.tintInk, presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET }).catch(() => undefined);
  } else {
    await Linking.openURL(url).catch(() => undefined);
  }
}
