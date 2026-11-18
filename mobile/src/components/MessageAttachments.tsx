import { useEffect, useRef, useState } from "react";
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
import { WebView } from "react-native-webview";
import { Maximize2, Share as ShareIcon, X } from "lucide-react-native";
import { IconButton } from "@/components/IconButton";
import { FILE_ICONS, fileKind, fileKindWord, formatFileSize } from "@/lib/files";
import { haptics } from "@/lib/haptics";
import { openLink } from "@/lib/links";
import { type Theme, useTheme } from "@/lib/theme";

/** A photo or file a message carries: its address, the header the computer asks for before it sends one of its own, and its own name. */
export type Shown = { uri: string; headers?: Record<string, string>; name: string; size?: number | null };

// A message's one photo fits this box; several are a row of square tiles.
const PHOTO_BOX = 228;
const PHOTO_TILE = 104;
const FILE_CARD_WIDTH = 280;
const VIEWER_TOP_BAR = 56;
/** How far a picture at rest is pulled down before the viewer lets it go. */
const DISMISS_PULL = 90;
// A page in the chat is as tall as what it holds, between these, and the third until it is measured. Full screen shows the rest of a longer one.
const PAGE_SHORTEST = 60;
const PAGE_TALLEST = 480;
const PAGE_UNMEASURED = 160;
// How long after the person touches a page a link in it may open, which is as long as a tap takes to reach it.
const TAP_MS = 1000;

// Each photo's shape once it has loaded, so a lone photo keeps its shape when the chat draws it again.
const shapes = new Map<string, { width: number; height: number }>();

// Each page's text and the copy of it saved on the phone, and its height in the chat once measured, so a page scrolled away and back shows as it was.
const pages = new Map<string, { html: string; file: string }>();
const pageHeights = new Map<string, number>();

/** A lone photo's frame: its own shape, kept between 3:4 and 4:3, fitted to the box. */
function photoFrame(shape: { width: number; height: number } | undefined, box: number): { width: number; height: number } {
  const ratio = shape ? shape.height / shape.width : 1;
  const clamped = Math.min(4 / 3, Math.max(3 / 4, ratio));
  return clamped > 1 ? { width: Math.round(box / clamped), height: box } : { width: box, height: Math.round(box * clamped) };
}

/** Saves a sent file on the phone, so the share sheet can hand it on and a page can be read. */
async function local(item: Shown): Promise<string> {
  if (!item.uri.startsWith("http")) return item.uri;
  const folder = new Directory(Paths.cache, "sent");
  folder.create({ idempotent: true, intermediates: true });
  const file = await File.downloadFileAsync(item.uri, new File(folder, item.uri.split("/").pop() ?? item.name), { idempotent: true, headers: item.headers });
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
            source={{ uri: photo.uri, headers: photo.headers }}
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
        <Image source={{ uri: photo.uri, headers: photo.headers }} contentFit="contain" transition={200} style={StyleSheet.absoluteFill} onLoad={() => setLoaded(true)} accessibilityLabel={photo.name} />
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

/**
 * What a page is given before its own content loads: a phone's width to lay
 * out in, and the chat's colours, as its defaults and as CSS variables for its
 * own styles. Run again, it gives the page the colours of the other mode.
 */
function dress(theme: Theme): string {
  const css =
    `:root{color-scheme:${theme.dark ? "dark" : "light"};--bg:${theme.bg};--ink:${theme.ink};--ink2:${theme.ink2};--line:${theme.line};--field:${theme.field};--tint:${theme.tint}}` +
    `html{background:var(--bg);color:var(--ink);font:17px/1.3 -apple-system,system-ui,sans-serif;-webkit-text-size-adjust:100%}body{margin:0}a{color:${theme.tintInk}}`;
  return `(function(){var d=document,r=d.documentElement,s=d.getElementById("sidebots");if(!s){var m=d.createElement("meta");m.name="viewport";m.content="width=device-width,initial-scale=1";r.appendChild(m);s=d.createElement("style");s.id="sidebots";r.appendChild(s);}s.textContent=${JSON.stringify(css)};})();true;`;
}

// Tells the app how tall the page's content is, now and as it changes.
const MEASURE = `(function(){var r=document.documentElement,last;function tell(){var h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(h!==last){last=h;window.ReactNativeWebView.postMessage(String(h));}}new ResizeObserver(tell).observe(r);if(document.body)new ResizeObserver(tell).observe(document.body);window.addEventListener("load",tell);tell();})();true;`;

/**
 * A page the agent wrote, drawn from its text. The page is closed off from
 * the app: it loads as a document of no site, so it holds none of the phone's
 * keys, keeps nothing between openings, can't use the camera or microphone,
 * and can't leave for another page. A web link opens over the app, as a link
 * in a reply does, and only as the person taps the page, so a page's own
 * script opens nothing. Its scripts run, and it may fetch from the web.
 * `onHeight` hears how tall its content is.
 */
function PageView({ html, scrolls, onHeight }: { html: string; scrolls: boolean; onHeight?: (height: number) => void }) {
  const theme = useTheme();
  const view = useRef<WebView<object>>(null);
  // The web view is made again when iOS ends the process that draws it.
  const [life, setLife] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // The life whose page has begun to load. Nothing replaces the page after that.
  const begun = useRef(-1);
  const touched = useRef(0);
  const touch = () => {
    touched.current = Date.now();
  };
  // The colours follow the phone into light or dark while the page is open.
  useEffect(() => view.current?.injectJavaScript(dress(theme)), [theme]);
  const open = (url: string) => {
    if (Date.now() - touched.current < TAP_MS && /^https?:\/\//i.test(url)) void openLink(url, theme);
  };
  return (
    <View style={styles.pageView} onTouchStart={touch} onTouchEnd={touch}>
      <WebView<object>
        key={life}
        ref={view}
        source={{ html }}
        // Every address comes to onShouldStartLoadWithRequest, which lets none of them replace the page.
        originWhitelist={["*"]}
        injectedJavaScriptBeforeContentLoaded={dress(theme)}
        injectedJavaScript={onHeight ? MEASURE : undefined}
        onMessage={({ nativeEvent }) => {
          const height = Number(nativeEvent.data);
          if (height > 0) onHeight?.(height);
        }}
        onShouldStartLoadWithRequest={(request) => {
          // A frame inside the page, and a place further down the page, load as they are.
          if (!request.isTopFrame || request.url.startsWith("about:blank#")) return true;
          if (request.url === "about:blank" && begun.current !== life) {
            begun.current = life;
            return true;
          }
          if (request.navigationType === "click") open(request.url);
          return false;
        }}
        onOpenWindow={({ nativeEvent }) => open(nativeEvent.targetUrl)}
        onContentProcessDidTerminate={() => {
          setLoaded(false);
          setLife((lives) => lives + 1);
        }}
        onLoadEnd={() => setLoaded(true)}
        incognito
        mediaCapturePermissionGrantType="deny"
        allowsLinkPreview={false}
        dataDetectorTypes="none"
        scrollEnabled={scrolls}
        style={styles.pageWeb}
      />
      {loaded ? null : <ActivityIndicator style={StyleSheet.absoluteFill} color={theme.ink2} />}
    </View>
  );
}

/**
 * A page the agent sent, as T3 Code shows one: drawn in the chat above the
 * reply, in the chat's colours, as tall as what it holds up to a limit. The
 * button beside its name opens it full screen, where a longer page scrolls.
 * A page the phone can't fetch shows as its file card.
 */
export function MessagePage({ page }: { page: Shown }) {
  const theme = useTheme();
  const [saved, setSaved] = useState(pages.get(page.uri));
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(pageHeights.get(page.uri) ?? PAGE_UNMEASURED);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (pages.has(page.uri)) return;
    let showing = true;
    local(page)
      .then(async (file) => ({ html: await new File(file).text(), file }))
      .then(
        (fetched) => {
          pages.set(page.uri, fetched);
          if (showing) setSaved(fetched);
        },
        () => showing && setFailed(true),
      );
    return () => {
      showing = false;
    };
    // The page is the same one for as long as its address is.
  }, [page.uri]);
  if (failed) return <FileCard file={page} />;
  const title = page.name.replace(/\.html$/i, "");
  return (
    <View style={styles.pageCard}>
      <View style={styles.pageHead}>
        <Text numberOfLines={1} style={[styles.pageName, { color: theme.ink2 }]}>
          {title}
        </Text>
        <IconButton icon={Maximize2} label={`Open ${title} full screen`} onPress={() => setFull(true)} disabled={!saved} size={28} iconSize={16} color={theme.ink2} />
      </View>
      <View style={{ height }}>
        {saved ? (
          <PageView
            html={saved.html}
            scrolls={false}
            onHeight={(measured) => {
              const fitted = Math.min(PAGE_TALLEST, Math.max(PAGE_SHORTEST, measured));
              pageHeights.set(page.uri, fitted);
              setHeight(fitted);
            }}
          />
        ) : (
          <ActivityIndicator style={StyleSheet.absoluteFill} color={theme.ink2} />
        )}
      </View>
      {/* Share hands on the copy the phone already has, so it works out of the computer's reach. */}
      {full && saved ? <FullScreenPage page={{ ...page, uri: saved.file }} title={title} html={saved.html} onClose={() => setFull(false)} /> : null}
    </View>
  );
}

/** A page full screen, on the page's own colour: it scrolls and zooms, with Close and Share above it. */
function FullScreenPage({ page, title, html, onClose }: { page: Shown; title: string; html: string; onClose: () => void }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType={reduceMotion ? "none" : "slide"} presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.viewer, { backgroundColor: theme.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.pageBar}>
          <IconButton icon={X} label="Close" onPress={onClose} />
          <Text numberOfLines={1} style={[styles.viewerTitle, { color: theme.ink }]}>
            {title}
          </Text>
          <IconButton icon={ShareIcon} label="Share" onPress={() => void share(page)} />
        </View>
        <View style={styles.pageRoom}>
          <PageView html={html} scrolls />
        </View>
      </View>
    </Modal>
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
  pageCard: { alignSelf: "stretch" },
  pageHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 2 },
  pageName: { flex: 1, fontSize: 13, lineHeight: 18 },
  pageView: { flex: 1 },
  pageWeb: { flex: 1, backgroundColor: "transparent" },
  pageBar: { height: VIEWER_TOP_BAR, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 },
  pageRoom: { flex: 1, paddingHorizontal: 16 },
});
