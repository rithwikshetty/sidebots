import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Drawer, useDrawerProgress } from "react-native-drawer-layout";
import { GestureHandlerRootView, type LegacyPanGesture } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { SideMenu, SideMenuContext } from "@/components/SideMenu";
import { usePaired } from "@/lib/api";
import { haptics } from "@/lib/haptics";
import { startSync } from "@/lib/state";
import { useTheme } from "@/lib/theme";

// Home is always the first screen, even under a chat that a tap on its agent's Live Activity opens.
export const unstable_settings = { anchor: "index" };

/**
 * Every screen, in one stack, inside the side menu. The menu stays still
 * while the screens slide aside to uncover it. On the home screen a swipe
 * right from anywhere opens it, diagonals included; deeper in the stack the
 * swipe belongs to going back. The list's scroll waits for the menu to judge
 * each drag (`ScrollWaitsForMenuSwipe` in the list): more right than up or
 * down is the menu's, anything else is the list's or a row's. A row with its
 * actions showing holds the swipe, so a swipe right closes it first. The menu
 * gives a light tap as it opens, and shuts when the phone disconnects.
 */
export default function Layout() {
  const theme = useTheme();
  const paired = usePaired();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [swipeHeld, setSwipeHeld] = useState(false);
  const menu = useMemo(() => ({ open: () => setMenuOpen(true), holdSwipe: setSwipeHeld }), []);
  // The drawer builds its swipe with gesture-handler's legacy builder. Both
  // ends of the offset are set, since the builder keeps the drawer's own end
  // for any it isn't given; a screen's width either way is further than a
  // finger can go. While shut, whichever of 8pt right, 8pt left or 8pt up or
  // down comes first decides, so the menu takes a drag that heads more right
  // than up or down. Once open, a swipe across closes it.
  const swipeOpensMenu = useCallback(
    (swipe: LegacyPanGesture) =>
      menuOpen ? swipe.activeOffsetX([-14, 14]).failOffsetY([-10, 10]) : swipe.activeOffsetX([-width, 8]).failOffsetX([-8, width]).failOffsetY([-8, 8]),
    [menuOpen, width],
  );
  useEffect(startSync, []);
  useEffect(() => {
    if (menuOpen) haptics.menu();
  }, [menuOpen]);
  useEffect(() => {
    if (!paired) setMenuOpen(false);
  }, [paired]);

  const base = theme.dark ? DarkTheme : DefaultTheme;
  const navigation = {
    ...base,
    colors: { ...base.colors, primary: theme.tintInk, background: theme.bg, card: theme.bg, text: theme.ink, border: theme.line },
  };

  // No screen has a title bar. Each one floats its own controls over its content.
  // The gesture root is what lets a row and a message follow a swipe.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={navigation}>
          <StatusBar style="auto" />
          <SideMenuContext.Provider value={menu}>
            <Drawer
              open={menuOpen}
              onOpen={menu.open}
              onClose={() => setMenuOpen(false)}
              drawerType="back"
              swipeEnabled={pathname === "/" && (menuOpen || !swipeHeld)}
              swipeEdgeWidth={width}
              configureGestureHandler={swipeOpensMenu}
              style={{ backgroundColor: theme.field }}
              drawerStyle={{ width: Math.min(width * 0.8, 340), backgroundColor: theme.field }}
              overlayStyle={styles.overlay}
              renderDrawerContent={() => <SideMenu />}>
              <Shell>
                <Stack screenOptions={{ headerShown: false }}>
                  {/* A phone that hasn't paired with a computer has the welcome and pairing screens and nothing else, and opens on welcome. Once paired, it has everything but those. */}
                  <Stack.Protected guard={paired} redirectTo="/welcome">
                    <Stack.Screen name="index" />
                    <Stack.Screen name="chat/[id]" />
                    <Stack.Screen name="new-agent" options={{ presentation: "formSheet", sheetAllowedDetents: [0.62], sheetGrabberVisible: true }} />
                    {/* An agent's page, and a note opened from it, each a sheet over what is behind. */}
                    <Stack.Screen name="agent/[id]" options={{ presentation: "modal" }} />
                    <Stack.Screen name="note" options={{ presentation: "modal" }} />
                    <Stack.Screen
                      name="camera"
                      // Full screen and a quick fade, so the camera is up the moment it's chosen. The status bar is light on its black.
                      options={{ presentation: "fullScreenModal", animation: "fade", animationDuration: 150, contentStyle: { backgroundColor: theme.viewer }, statusBarStyle: "light" }}
                    />
                  </Stack.Protected>
                  <Stack.Protected guard={!paired}>
                    <Stack.Screen name="(unpaired)" options={{ animation: "fade" }} />
                  </Stack.Protected>
                </Stack>
              </Shell>
            </Drawer>
          </SideMenuContext.Provider>
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const SHELL_RADIUS = 48;

/**
 * The screens as they slide aside off the side menu: their corners round off
 * early in the slide, and a soft shadow and a hairline edge draw in, so they
 * read as a card lifted over the menu's colour. The shadow sits on an outer
 * view, since the inner one clips the screens to the rounded corners and a
 * clipped view drops its shadow.
 */
function Shell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const progress = useDrawerProgress();
  const rounded = useAnimatedStyle(() => ({ borderRadius: interpolate(progress.value, [0, 0.15], [0, SHELL_RADIUS], "clamp") }));
  const lifted = useAnimatedStyle(() => ({ shadowOpacity: interpolate(progress.value, [0, 1], [0, 0.14], "clamp") }));
  const edge = useAnimatedStyle(() => ({ opacity: interpolate(progress.value, [0, 0.15], [0, 1], "clamp") }));
  return (
    <Animated.View style={[styles.lift, { backgroundColor: theme.bg }, rounded, lifted]}>
      <Animated.View style={[styles.shell, rounded]}>
        {children}
        <Animated.View pointerEvents="none" style={[styles.edge, { borderColor: theme.line }, rounded, edge]} />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { backgroundColor: "transparent" },
  lift: { flex: 1, shadowColor: "#000", shadowRadius: 28, shadowOffset: { width: -6, height: 0 } },
  shell: { flex: 1, overflow: "hidden" },
  edge: { ...StyleSheet.absoluteFill, borderWidth: StyleSheet.hairlineWidth },
});
