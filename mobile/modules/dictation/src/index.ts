import { requireNativeModule } from "expo";

type DictationModule = {
  /** Whether this phone has Apple's speech model, which needs iOS 26. */
  isAvailable(): boolean;
  /**
   * Picks the first of the phone's languages the model knows, downloading it
   * the first time, and resolves with its locale, such as `en-US`.
   */
  prepare(): Promise<string>;
  /** The words in the recording at `uri`, in a locale from `prepare`. */
  transcribe(uri: string, locale: string): Promise<string>;
};

/** Turns a recording into text on the phone, so the audio never leaves it. */
export const Dictation = requireNativeModule<DictationModule>("Dictation");
