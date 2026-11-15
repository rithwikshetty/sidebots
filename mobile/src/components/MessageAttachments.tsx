import { useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Image } from "expo-image";
import { Directory, File, Paths } from "expo-file-system";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Share as ShareIcon, X } from "lucide-react-native";
import { IconButton } from "@/components/IconButton";
import { FILE_ICONS, fileKind, fileKindWord, formatFileSize } from "@/lib/files";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";

/** A photo or file a message carries: its address and its own name. */
export type Shown = { uri: string; name: string; size?: number | null };

// A message's one photo fits this box; several are a row of square tiles.
const PHOTO_BOX = 228;
const PHOTO_TILE = 104;
const FILE_CARD_WIDTH = 280;
const VIEWER_TOP_BAR = 56;
/** How far a picture at rest is pulled down before the viewer lets it go. */
const DISMISS_PULL = 90;

// Each photo's shape once it has loaded, so a lone photo keeps its shape when the chat draws it again.
const shapes = new Map<string, { width: number; height: number }>();

/** A lone photo's frame: its own shape, kept between 3:4 and 4:3, fitted to the box. */
function photoFrame(shape: { width: number; height: number } | undefined, box: number): { width: number; height: number } {
  const ratio = shape ? shape.height / shape.width : 1;
  const clamped = Math.min(4 / 3, Math.max(3 / 4, ratio));
  return clamped > 1 ? { width: Math.round(box / clamped), height: box } : { width: box, height: Math.round(box * clamped) };
}

/** Saves a sent file on the phone, so the share sheet can hand it on. */
async function local(item: Shown): Promise<string> {
  if (!item.uri.startsWith("http")) return item.uri;
  const folder = new Directory(Paths.cache, "sent");
  folder.create({ idempotent: true, intermediates: true });
  const file = await File.downloadFileAsync(item.uri, new File(folder, item.uri.split("/").pop() ?? item.name), { idempotent: true });
  return file.uri;
}

async function share(item: Shown): Promise<void> {
  await Share.share({ url: await local(item) }).catch(() => undefined);
}

/**
 * The photos a message carries, above its bubble, as Assist shows them: one
 * in its own shape, or a row of square tiles. A tap opens them full screen.
 */
export function MessagePhotos({ photos, end }: { photos: Shown[]; end: boolean }) {
  const theme = useTheme();
  const [viewing, setViewing] = useState<number | null>(null);
  const [, redraw] = useState(0);
  const lone = photos.length === 1 ? photoFrame(shapes.get(photos[0].uri), PHOTO_BOX) : null;
  return (
    <View style={[styles.photos, { justifyContent: end ? "flex-end" : "flex-start" }]}>
      {photos.map((photo, index) => (
        <Pressable
          key={photo.uri}
          onPress={() => {
            haptics.select();
            setViewing(index);
          }}
          accessibilityRole="imagebutton"
          accessibilityLabel={photo.name}
          accessibilityHint="Opens it full screen"
          style={[styles.tile, { width: lone?.width ?? PHOTO_TILE, height: lone?.height ?? PHOTO_TILE, backgroundColor: theme.field }]}>
          <Image
            source={{ uri: photo.uri }}
            contentFit="cover"
            transition={120}
            style={StyleSheet.absoluteFill}
            onLoad={({ source }) => {
              if (shapes.has(photo.uri)) return;
              shapes.set(photo.uri, { width: source.width, height: source.height });
              if (lone) redraw((n) => n + 1);
            }}
          />
        </Pressable>
      ))}
      {viewing !== null ? <PhotoViewer photos={photos} start={viewing} onClose={() => setViewing(null)} /> : null}
    </View>
  );
}

/** One page of the viewer: pinch to zoom, pull down to close. */
function ViewerPage({ photo, width, height, reservedTop, reservedBottom, onClose }: {
  photo: Shown;
  width: number;
  height: number;
  reservedTop: number;
  reservedBottom: number;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [loaded, setLoaded] = useState(false);
  const zoomed = useRef(false);
  const onScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, zoomScale } = event.nativeEvent;
    if (!zoomed.current && (zoomScale ?? 1) <= 1 && Math.abs(contentOffset.y) > DISMISS_PULL) onClose();
  };
  const shape = shapes.get(photo.uri);
  const roomHeight = Math.max(1, height - reservedTop - reservedBottom);
  const fit = shape ? Math.min(width / shape.width, roomHeight / shape.height) : 1;
  const box = shape ? { width: shape.width * fit, height: shape.height * fit } : { width, height: roomHeight };
  return (
    <ScrollView
      style={{ width, height }}
      contentContainerStyle={[styles.page, { paddingTop: reservedTop, paddingBottom: reservedBottom }]}
      maximumZoomScale={4}
      minimumZoomScale={1}
      bouncesZoom
      centerContent
      alwaysBounceVertical
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      onScrollEndDrag={onScrollEndDrag}
      onScroll={(event) => {
        zoomed.current = (event.nativeEvent.zoomScale ?? 1) > 1.01;
      }}
      scrollEventThrottle={32}>
      <View style={box}>
        <Image source={{ uri: photo.uri }} contentFit="contain" transition={200} style={StyleSheet.absoluteFill} onLoad={() => setLoaded(true)} accessibilityLabel={photo.name} />
        {loaded ? null : <ActivityIndicator style={StyleSheet.absoluteFill} color={theme.viewerInk} />}
      </View>
    </ScrollView>
  );
}

/**
 * A message's photos full screen on black, as Assist's viewer: swipe between
 * them, pinch to zoom, pull down or Close to go back, and Share at the
 * bottom.
 */
function PhotoViewer({ photos, start, onClose }: { photos: Shown[]; start: number; onClose: () => void }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(start);
  const current = photos[index];
  const topRoom = insets.top + VIEWER_TOP_BAR;
  const bottomRoom = insets.bottom + 64;
  return (
    <Modal visible animationType={reduceMotion ? "none" : "fade"} presentationStyle="overFullScreen" transparent statusBarTranslucent onRequestClose={onClose}>
      <View style={[styles.viewer, { backgroundColor: theme.viewer }]}>
        {/* Pages are the window's width, so a window that changes width opens the pages again at the picture on screen. */}
        <FlatList
          key={width}
          data={photos}
          keyExtractor={(photo) => photo.uri}
          horizontal
          pagingEnabled
          initialScrollIndex={index}
          getItemLayout={(_, item) => ({ length: width, offset: width * item, index: item })}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) => setIndex(Math.round(event.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => (
            <ViewerPage photo={item} width={width} height={height} reservedTop={topRoom} reservedBottom={bottomRoom} onClose={onClose} />
          )}
        />
        <View style={[styles.viewerTop, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
          <IconButton icon={X} label="Close" onPress={onClose} variant="overlay" iconSize={18} />
          <Text numberOfLines={1} style={[styles.viewerTitle, { color: theme.viewerInk }]}>
            {photos.length > 1 ? `${index + 1} of ${photos.length}` : (current?.name ?? "")}
          </Text>
          <View style={styles.viewerSpacer} />
        </View>
        <View style={[styles.viewerBar, { paddingBottom: insets.bottom + 10 }]}>
          <IconButton icon={ShareIcon} label="Share" onPress={() => current && void share(current)} variant="overlay" iconSize={20} size={44} />
        </View>
      </View>
    </Modal>
  );
}

/**
 * One file a message carries, as Assist's file card: its kind's icon, its
 * name, and its kind and size. A tap opens the share sheet, which previews
 * it and offers Save to Files.
 */
export function FileCard({ file }: { file: Shown }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const Icon = FILE_ICONS[fileKind(file.name)];
  const meta = [fileKindWord(file.name), formatFileSize(file.size ?? null)].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={() => {
        setBusy(true);
        void share(file).finally(() => setBusy(false));
      }}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${meta}`}
      accessibilityHint="Opens the file"
      accessibilityState={{ busy }}
      style={({ pressed }) => [styles.card, { backgroundColor: pressed ? theme.field : theme.card, borderColor: theme.line }]}>
      <View style={[styles.icon, { backgroundColor: theme.field }]}>
        {busy ? <ActivityIndicator size="small" color={theme.ink2} /> : <Icon size={18} color={theme.tintInk} />}
      </View>
      <View style={styles.cardText}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.ink }]}>
          {file.name}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: theme.ink2 }]}>
          {meta}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  photos: { flexDirection: "row", flexWrap: "wrap", gap: 4, maxWidth: PHOTO_TILE * 3 + 8 },
  tile: { borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
  page: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
  viewer: { flex: 1 },
  viewerTop: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 },
  viewerTitle: { flex: 1, textAlign: "center", fontWeight: "500", fontSize: 15, lineHeight: 20 },
  viewerSpacer: { width: 36 },
  viewerBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", justifyContent: "space-evenly", alignItems: "center", paddingTop: 12 },
  card: {
    width: FILE_CARD_WIDTH,
    maxWidth: "100%",
    minHeight: 56,
    paddingVertical: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  icon: { width: 36, height: 36, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  cardText: { flex: 1, minWidth: 0, gap: 1 },
  name: { fontSize: 15, lineHeight: 20, fontWeight: "500" },
  meta: { fontSize: 13, lineHeight: 18 },
});
