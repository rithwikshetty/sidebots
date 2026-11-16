import { useState, type ReactNode, type Ref } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { CameraView, type CameraType } from "expo-camera";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

// The preview holds the sensor's 3:4 shape, so it shows all the camera sees and frames what a photo keeps.
const PREVIEW_RATIO = 3 / 4;
const QR_ONLY = { barcodeTypes: ["qr" as const] };

/**
 * The live camera, in the largest 3:4 frame that fits the room it is given.
 * The camera starts at once and fades in over `backdrop` once it is ready.
 * With `onScanned` it reads QR codes, and hands over what each one holds, many
 * times a second while a code is in view. `children` are drawn over the frame.
 */
export function CameraPreview({ ref, facing = "back", flash = false, backdrop, onReady, onMountError, onScanned, children }: {
  ref?: Ref<CameraView>;
  facing?: CameraType;
  flash?: boolean;
  backdrop: string;
  onReady?: () => void;
  onMountError?: () => void;
  onScanned?: (data: string) => void;
  children?: ReactNode;
}) {
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const shown = useSharedValue(0);
  const previewStyle = useAnimatedStyle(() => ({ opacity: shown.value }));

  // The largest 3:4 frame that fits the room.
  const fit = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    const width = Math.min(layout.width, layout.height * PREVIEW_RATIO);
    setFrame({ width, height: width / PREVIEW_RATIO });
  };

  return (
    <View style={styles.stage} onLayout={fit}>
      <View style={[styles.frame, frame ?? styles.unmeasured, { backgroundColor: backdrop }]}>
        <Animated.View style={[StyleSheet.absoluteFill, previewStyle]}>
          <CameraView
            ref={ref}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash && facing === "back" ? "on" : "off"}
            responsiveOrientationWhenOrientationLocked
            barcodeScannerSettings={onScanned ? QR_ONLY : undefined}
            onBarcodeScanned={onScanned ? ({ data }) => onScanned(data) : undefined}
            onCameraReady={() => {
              shown.value = withTiming(1, { duration: 220 });
              onReady?.();
            }}
            onMountError={onMountError}
          />
        </Animated.View>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  frame: { borderRadius: 28, overflow: "hidden" },
  unmeasured: { width: "100%", height: "100%" },
});
