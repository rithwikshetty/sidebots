import { requireNativeView } from "expo";
import type { ViewProps } from "react-native";

/**
 * Placed inside a scrolling list, such as in its header, makes the list's
 * scroll wait until the side menu's swipe has decided which way the finger
 * is going, so a diagonal swipe right opens the menu instead of scrolling.
 */
export const ScrollWaitsForMenuSwipe = requireNativeView<ViewProps>("SideMenuSwipe");
