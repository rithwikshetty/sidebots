import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

/**
 * Laid along the strip under the status bar where a screen's top buttons
 * sit, tells `onRoom` how much room iPadOS's window controls take at its
 * leading end, and again whenever that changes.
 * It is 0 where there are none: on an iPhone, and for an iPad app in full
 * screen.
 */
export const WindowControlsRoom = requireNativeView<ViewProps & { onRoom: (event: NativeSyntheticEvent<{ leading: number }>) => void }>("WindowControls");
