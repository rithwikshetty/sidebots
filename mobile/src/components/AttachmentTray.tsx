import { useRef } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition, useReducedMotion } from "react-native-reanimated";
import { X } from "lucide-react-native";
import { fileKind, fileMeta } from "@client/files";
import { FILE_ICONS, type Picked } from "@/lib/files";
import { useTheme } from "@/lib/theme";

const TILE = 56;
// Each tile leaves this much room above and to its right, so its remove
// button's 44pt target can reach past the tile's corner.
const OVERHANG = 16;
const TARGET = 44;
/** The tray's height, which the composer leaves above its text while the tray holds anything. */
export const TRAY_HEIGHT = TILE + OVERHANG;
const FILE_TILE_WIDTH = 176;
// A tile's two lines fit its fixed height up to this text size.
const TILE_MAX_SCALE = 1.3;
const TILE_MOTION = LinearTransition.duration(220);
/** How long a removed tile takes to fade out. */
export const TRAY_TILE_EXIT_MS = 120;

/**
 * The small round X in a tile's corner, inside a 44pt target that reaches up
 * and right past the tile.
 */
function RemoveButton({ file, onRemove }: { file: Picked; onRemove: (file: Picked) => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={() => onRemove(file)} accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} style={styles.removeTarget}>
      {({ pressed }) => (
        <View style={[styles.remove, { backgroundColor: theme.scrim, opacity: pressed ? 0.6 : 1 }]}>
          <X size={11} strokeWidth={3} color={theme.viewerInk} />
        </View>
      )}
    </Pressable>
  );
}

function Tile({ file, onRemove }: { file: Picked; onRemove: (file: Picked) => void }) {
  const theme = useTheme();
  const Icon = FILE_ICONS[fileKind(file.name)];
  const meta = fileMeta(file.name, file.size);
  return (
    <View style={styles.tileFrame}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={file.name}
        style={[file.photo ? styles.photo : styles.file, { backgroundColor: file.photo ? theme.field : theme.bg, borderColor: theme.line }]}>
        {file.photo ? (
          <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
        ) : (
          <>
            <View style={[styles.icon, { backgroundColor: theme.field }]}>
              <Icon size={16} color={theme.tintInk} />
            </View>
            <View style={styles.fileText}>
              <Text maxFontSizeMultiplier={TILE_MAX_SCALE} numberOfLines={1} style={[styles.name, { color: theme.ink }]}>
                {file.name}
              </Text>
              <Text maxFontSizeMultiplier={TILE_MAX_SCALE} numberOfLines={1} style={[styles.status, { color: theme.ink2 }]}>
                {meta}
              </Text>
            </View>
          </>
        )}
      </View>
      <RemoveButton file={file} onRemove={onRemove} />
    </View>
  );
}

/**
 * A row of tiles, each with a remove button: the photos and files picked for
 * the next message above the composer's text, or the photos the camera has
 * taken. A photo is a small square; a file is a card with its kind's icon,
 * its name, and its kind and size. The row scrolls to the end when a tile
 * joins it, so the newest is in view. Taps on the tray leave the keyboard up.
 */
export function AttachmentTray({ files, onRemove }: { files: readonly Picked[]; onRemove: (file: Picked) => void }) {
  const reduceMotion = useReducedMotion();
  const scroll = useRef<ScrollViewInstance>(null);
  const width = useRef(0);
  return (
    <ScrollView
      ref={scroll}
      onContentSizeChange={(contentWidth) => {
        if (contentWidth > width.current) scroll.current?.scrollToEnd({ animated: !reduceMotion });
        width.current = contentWidth;
      }}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      contentContainerStyle={styles.row}
      style={styles.tray}>
      {files.map((file) => (
        <Animated.View
          key={file.uri}
          entering={reduceMotion ? undefined : FadeIn.duration(180)}
          exiting={reduceMotion ? undefined : FadeOut.duration(TRAY_TILE_EXIT_MS)}
          layout={reduceMotion ? undefined : TILE_MOTION}>
          <Tile file={file} onRemove={onRemove} />
        </Animated.View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tray: { height: TRAY_HEIGHT, flexGrow: 0 },
  row: { paddingLeft: 10, paddingRight: 10 - OVERHANG + 8, alignItems: "flex-end" },
  tileFrame: { paddingTop: OVERHANG, paddingRight: OVERHANG - 8 },
  photo: { width: TILE, height: TILE, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" },
  file: {
    width: FILE_TILE_WIDTH,
    height: TILE,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 8,
    paddingRight: 24,
    borderRadius: 12,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  icon: { width: 32, height: 32, borderRadius: 9, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  fileText: { flex: 1, minWidth: 0 },
  name: { fontWeight: "500", fontSize: 13, lineHeight: 17 },
  status: { fontSize: 12, lineHeight: 16 },
  // The target's corner is the frame's; the X sits 4pt inside the tile's corner.
  removeTarget: {
    position: "absolute",
    top: 0,
    right: 0,
    width: TARGET,
    height: TARGET,
    alignItems: "flex-end",
    paddingTop: OVERHANG + 4,
    paddingRight: OVERHANG - 8 + 4,
  },
  remove: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
});
