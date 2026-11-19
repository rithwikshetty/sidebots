// How a screen fits the window. The iPhone stays upright, and its window is
// always one column. The iPad turns every way and iPadOS sizes the app's
// window to any width, so a screen sizes itself from the window, never from
// the device. A window as wide as an iPad held upright splits: the agents
// take a column at its left, and the chat the rest. An iPad app in a window
// of its own has the window's controls at the top left, which what sits
// there moves aside for. The root layout works all of it out once, and every
// screen reads it.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, useWindowDimensions } from "react-native";

/** The narrowest window that splits, which every iPad's whole screen is. */
const SPLIT_MIN_WIDTH = 700;
/** The agents' column in a split window, as wide as the side menu. */
export const SIDEBAR_WIDTH = 340;
/** The widest a chat's messages and composer run, centred in a wider chat: Assist's reading column. */
const READING_WIDTH = 832;

type WindowLayout = {
  /** Whether the window splits, with the agents in a column beside the chat. */
  split: boolean;
  /** The room at each side of a chat's messages and composer that keeps them to the reading column, centred. */
  readingMargin: number;
  /**
   * The room iPadOS's window controls take at the left of the window's top,
   * past the safe area. 0 where there are none: on an iPhone, and for an iPad
   * app in full screen.
   */
  controls: number;
};

/** The window's layout, which the root layout gives every screen. */
export const WindowLayout = createContext<WindowLayout>({ split: false, readingMargin: 0, controls: 0 });

/**
 * Works out the window's layout, from its width while the app is in front and
 * the room its controls take. iPadOS turns an app in the background to take
 * its snapshots, which must not fold the split and back.
 */
export function useWindowLayout(controls: number): WindowLayout {
  const { width } = useWindowDimensions();
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  const held = useRef(width);
  if (active) held.current = width;
  const front = held.current;
  return useMemo(() => {
    const split = front >= SPLIT_MIN_WIDTH;
    const chat = split ? front - SIDEBAR_WIDTH : front;
    return { split, readingMargin: Math.max(0, Math.floor((chat - READING_WIDTH) / 2)), controls };
  }, [front, controls]);
}

/** Whether the window splits, with the agents in a column beside the chat. */
export function useSplit(): boolean {
  return useContext(WindowLayout).split;
}

/** The room at each side of a chat's messages and composer that keeps them to the reading column, centred. None in a chat narrower than it. */
export function useReadingMargin(): number {
  return useContext(WindowLayout).readingMargin;
}

/** How far a button at a screen's top left moves right to keep clear of the window's controls. */
export function useWindowControls(): number {
  return useContext(WindowLayout).controls;
}
