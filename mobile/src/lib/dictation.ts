import { useEffect, useRef, useState } from "react";
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { Dictation } from "../../modules/dictation/src";
import { problem } from "./alerts";
import { haptics } from "./haptics";

/** Whether this phone can turn speech into text, which takes iOS 26. */
export const canDictate = Dictation.isAvailable();

export type DictationState = "idle" | "listening" | "transcribing";

/** How many of the latest loudness samples the waveform can draw. */
export const LEVEL_COUNT = 64;
const SILENT: number[] = Array(LEVEL_COUNT).fill(0);
// How often the recorder is asked how loud the voice is.
const SAMPLE_MS = 80;
const RECORDING = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };
// Quieter than this counts as silence.
const NOISE_FLOOR_DB = -60;
const NOISE_FLOOR = 10 ** (NOISE_FLOOR_DB / 20);

/**
 * The composer's microphone. `start` records the person's voice, and while
 * it does `levels` holds how loud the latest moments were, from 0 to 1, and
 * `seconds` how long it has run. `stop` turns the recording into text on the
 * phone and resolves with the words, or with nothing when there were none or
 * it didn't work, which the person is told. `cancel` drops the recording, or
 * the text still being made from it. Either way the recording is deleted.
 */
export function useDictation(): {
  state: DictationState;
  levels: SharedValue<number[]>;
  seconds: number;
  start(): Promise<void>;
  stop(): Promise<string>;
  cancel(): void;
} {
  const recorder = useAudioRecorder(RECORDING);
  const [state, setState] = useState<DictationState>("idle");
  const levels = useSharedValue(SILENT);
  const [seconds, setSeconds] = useState(0);
  // The language is made ready while the person speaks, as the first use downloads it.
  const locale = useRef<Promise<string> | null>(null);
  // Counts cancels, so text made from a cancelled recording is dropped.
  const generation = useRef(0);

  // Leaving the screen while it listens gives the microphone back. The recorder itself goes with the screen.
  const listening = useRef(false);
  useEffect(() => {
    listening.current = state === "listening";
  }, [state]);
  useEffect(
    () => () => {
      if (listening.current) void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    },
    [],
  );

  // The levels change many times a second, so they skip React and go straight to the waveform.
  useEffect(() => {
    if (state !== "listening") return;
    const timer = setInterval(() => {
      const status = recorder.getStatus();
      levels.set([...levels.get().slice(1), loudness(status.metering)]);
      setSeconds(Math.floor(status.durationMillis / 1000));
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [state, recorder, levels]);

  // Stops the recorder and gives the microphone back, resolving with the recording.
  const release = async () => {
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false });
    return recorder.uri;
  };

  const start = async () => {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Allow Simon to use the microphone in Settings to dictate a message.");
      const preparing = Dictation.prepare();
      // A failure here is told when the person stops, with the recording's.
      preparing.catch(() => {});
      locale.current = preparing;
      // iOS records only in the mode that also plays with the ringer off.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      levels.set(SILENT);
      setSeconds(0);
      setState("listening");
      haptics.listen();
    } catch (failure) {
      problem("Couldn't start listening", failure);
    }
  };

  const stop = async () => {
    const run = generation.current;
    setState("transcribing");
    haptics.listen();
    let uri: string | null = null;
    try {
      uri = await release();
      if (!uri || !locale.current) return "";
      const words = await Dictation.transcribe(uri, await locale.current);
      return run === generation.current ? words : "";
    } catch (failure) {
      if (run === generation.current) problem("Couldn't turn that into text", failure);
      return "";
    } finally {
      if (uri) remove(uri);
      if (run === generation.current) setState("idle");
    }
  };

  const cancel = () => {
    generation.current += 1;
    setState("idle");
    // While text is being made, the recording is deleted once that settles.
    if (state === "listening") void release().then((uri) => uri && remove(uri), () => {});
  };

  return { state, levels, seconds, start, stop, cancel };
}

/** A recorder reading in decibels as 0 for silence to 1 for full scale, spread so speech fills the range. */
function loudness(decibels: number | undefined): number {
  if (decibels === undefined || !Number.isFinite(decibels) || decibels <= NOISE_FLOOR_DB) return 0;
  if (decibels >= 0) return 1;
  return Math.sqrt((10 ** (decibels / 20) - NOISE_FLOOR) / (1 - NOISE_FLOOR));
}

function remove(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The recording sits in the cache, which the phone clears in time.
  }
}
