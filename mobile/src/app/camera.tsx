import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { CameraView, type CameraType } from "expo-camera";
import { File } from "expo-file-system";
import { router, useLocalSearchParams, useNavigation, usePreventRemove } from "expo-router";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, SwitchCamera, X, Zap, ZapOff } from "lucide-react-native";
import { AttachmentTray, TRAY_HEIGHT } from "@/components/AttachmentTray";
import { IconButton } from "@/components/IconButton";
import { cameraRequestLimit, FILE_LIMIT_NOTICE, pickedPhoto, settleCameraRequest, type Picked } from "@/lib/files";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";

// The preview holds the sensor's 3:4 shape, so it frames what the photo keeps.
const PREVIEW_RATIO = 3 / 4;
const SHUTTER = 76;
const FAILED = "The photo wasn't taken. Try again.";

/**
 * The camera, full screen over the chat: a live preview on black
 * that fades in once the camera is ready, Close and the flash above it, the
 * photos taken so far under it, and Add, the shutter and the switch between
 * the back and front cameras below. The shutter keeps the camera open and
 * adds each photo to the row, up to the room the message has left. Add hands
 * the photos to the composer and closes the camera. Closing it any other way
 * hands over nothing, and asks first once a photo has been taken.
 */
export default function Camera() {
  const theme = useTheme();
  const { request: id } = useLocalSearchParams<{ request?: string }>();
  // Read once: a camera opened for no request has nothing to hand photos to.
  const [limit] = useState(() => cameraRequestLimit(id));
  useEffect(() => () => settleCameraRequest(id, []), [id]);

  if (limit === undefined) {
    return (
      <View style={[styles.screen, styles.empty, { backgroundColor: theme.viewer }]}>
        <Text style={[styles.notice, { color: theme.viewerInk }]}>The camera isn't open for a message.</Text>
        <IconButton icon={X} label="Close" variant="overlay" size={40} iconSize={20} onPress={() => router.back()} />
      </View>
    );
  }
  return <Viewfinder id={id} limit={limit} />;
}

function Viewfinder({ id, limit }: { id: string | undefined; limit: number }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const camera = useRef<CameraView>(null);
  const leaving = useRef(false);
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState(false);
  const [ready, setReady] = useState(false);
  const [taking, setTaking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const [photos, setPhotos] = useState<Picked[]>([]);
  const shown = useSharedValue(0);
  const previewStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const count = photos.length;
  const full = count >= limit;
  const notice = failed ? FAILED : full ? FILE_LIMIT_NOTICE : null;

  // With photos taken, anything that would close the camera asks first.
  const [released, setReleased] = useState(false);
  const disablePrevention = usePreventRemove(count > 0 && !released, ({ repeat }) => {
    Alert.alert(count === 1 ? "Discard 1 photo?" : `Discard ${count} photos?`, "They haven't been added to your message.", [
      { text: "Keep taking photos", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          setReleased(true);
          repeat();
        },
      },
    ]);
  });

  // The largest 3:4 frame that fits the space between the bars.
  const fit = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    const width = Math.min(layout.width, layout.height * PREVIEW_RATIO);
    setFrame({ width, height: width / PREVIEW_RATIO });
  };

  const onReady = () => {
    setReady(true);
    shown.value = withTiming(1, { duration: 220 });
  };

  // Add and a camera that can't start each answer the request; the first answer stands.
  const finish = (files: Picked[]) => {
    settleCameraRequest(id, files);
    if (leaving.current || !navigation.isFocused()) return;
    leaving.current = true;
    setReleased(true);
    disablePrevention();
    router.back();
  };

  const take = async () => {
    if (!ready || taking || full || !camera.current) return;
    setTaking(true);
    setFailed(false);
    haptics.shutter();
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.9, exif: false });
      setPhotos((current) =>
        current.length < limit
          ? [...current, pickedPhoto({ uri: picture.uri, mimeType: "image/jpeg", fileSize: new File(picture.uri).size }, current.length)]
          : current,
      );
    } catch {
      setFailed(true);
    }
    setTaking(false);
  };

  return (
    <View style={[styles.screen, { backgroundColor: theme.viewer, paddingBottom: insets.bottom + 12 }]}>
      <View style={[styles.bar, { paddingTop: insets.top + 8 }]}>
        <IconButton icon={X} label="Close" variant="overlay" size={40} iconSize={20} onPress={() => router.back()} />
        {facing === "back" ? (
          <IconButton
            icon={flash ? Zap : ZapOff}
            label={flash ? "Flash on" : "Flash off"}
            variant="overlay"
            size={40}
            iconSize={19}
            onPress={() => {
              haptics.select();
              setFlash((on) => !on);
            }}
          />
        ) : null}
      </View>
      {/* The camera starts at once, while it is still fading in, and takes its 3:4 frame once the stage is measured. It shows only when ready. */}
      <View style={styles.stage} onLayout={fit}>
        <View style={[styles.frame, frame ?? styles.unmeasured, { backgroundColor: theme.viewerControl }]}>
          <Animated.View style={[StyleSheet.absoluteFill, previewStyle]}>
            <CameraView
              ref={camera}
              style={StyleSheet.absoluteFill}
              facing={facing}
              flash={flash && facing === "back" ? "on" : "off"}
              responsiveOrientationWhenOrientationLocked
              onCameraReady={onReady}
              onMountError={() => finish(photos)}
            />
          </Animated.View>
        </View>
      </View>
      <Text style={[styles.notice, { color: theme.viewerInk }]}>{notice ?? " "}</Text>
      {/* The row's room is kept from the start, so the preview doesn't move when the first photo joins it. */}
      <View style={styles.row}>
        {count > 0 ? <AttachmentTray files={photos} onRemove={(photo) => setPhotos((current) => current.filter((each) => each.uri !== photo.uri))} /> : null}
      </View>
      <View style={styles.controls}>
        <View style={styles.side}>
          {count > 0 ? (
            <Pressable
              onPress={() => finish(photos)}
              disabled={taking}
              accessibilityRole="button"
              style={({ pressed }) => [styles.add, { backgroundColor: theme.viewerInk, opacity: taking ? 0.5 : pressed ? 0.85 : 1 }]}>
              <Check size={18} strokeWidth={2.25} color={theme.viewer} />
              <Text style={[styles.addLabel, { color: theme.viewer }]}>{`Add ${count}`}</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => void take()}
          disabled={!ready || taking || full}
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          accessibilityState={{ disabled: !ready || taking || full }}
          style={[styles.shutter, { borderColor: theme.viewerInk, opacity: ready && !full ? 1 : 0.4 }]}>
          {({ pressed }) => (
            <View style={[styles.shutterFace, { backgroundColor: theme.viewerInk, transform: [{ scale: pressed || taking ? 0.88 : 1 }] }]} />
          )}
        </Pressable>
        <View style={[styles.side, styles.sideEnd]}>
          <IconButton
            icon={SwitchCamera}
            label={facing === "back" ? "Use the front camera" : "Use the back camera"}
            variant="overlay"
            size={48}
            iconSize={22}
            disabled={taking}
            onPress={() => {
              haptics.select();
              setFacing((side) => (side === "back" ? "front" : "back"));
            }}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { alignItems: "center", justifyContent: "center", gap: 16 },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12 },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  frame: { borderRadius: 28, overflow: "hidden" },
  unmeasured: { width: "100%", height: "100%" },
  notice: { textAlign: "center", paddingTop: 12, fontSize: 15, lineHeight: 20 },
  row: { height: TRAY_HEIGHT },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 32, paddingTop: 12 },
  // The sides share what the shutter leaves, so it stays centred whether or not Add shows.
  side: { flex: 1, alignItems: "flex-start" },
  sideEnd: { alignItems: "flex-end" },
  add: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingHorizontal: 20, borderRadius: 999 },
  addLabel: { fontWeight: "600", fontSize: 16, lineHeight: 20 },
  shutter: { width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2, borderWidth: 4, alignItems: "center", justifyContent: "center" },
  shutterFace: { width: SHUTTER - 14, height: SHUTTER - 14, borderRadius: (SHUTTER - 14) / 2 },
});
