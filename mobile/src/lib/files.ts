// Photos and files the person picks to send with a message.

import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { Camera } from "expo-camera";
import { KeyboardController } from "react-native-keyboard-controller";
import { File as FileIcon, FileImage, FileSpreadsheet, FileText, Presentation, type LucideIcon } from "lucide-react-native";

/** A photo or file on the phone, ready to send. `size` is in bytes, when the picker could tell. */
export type Picked = { uri: string; name: string; type: string; size: number | null; photo: boolean };
/** Where the composer's + menu picks from. */
export type PickSource = "photos" | "camera" | "files";

/** The most one message carries. */
export const MAX_FILES = 10;
export const FILE_LIMIT_NOTICE = `A message can carry up to ${MAX_FILES} files.`;
/** The most one message carries in bytes, as the server takes it. */
export const MAX_BYTES = 95 * 1024 * 1024;
export const SIZE_LIMIT_NOTICE = "A message can carry up to 95 MB of photos and files.";

/** Whether the files fit in one message. A file whose size the picker couldn't tell counts as nothing. */
export function fitsInMessage(files: Picked[]): boolean {
  return files.reduce((total, file) => total + (file.size ?? 0), 0) <= MAX_BYTES;
}

const IMAGE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;

/** Whether a file is a picture the app can show, going by its name. */
export function isImage(name: string): boolean {
  return IMAGE.test(name);
}

/** What kind of file it is, for its icon and the word under its name. */
export type FileKind = "image" | "pdf" | "sheet" | "document" | "slides" | "text" | "file";

const KINDS: [RegExp, FileKind][] = [
  [IMAGE, "image"],
  [/\.pdf$/i, "pdf"],
  [/\.(xlsx?|csv|numbers)$/i, "sheet"],
  [/\.(docx?|pages|rtf)$/i, "document"],
  [/\.(pptx?|key)$/i, "slides"],
  [/\.(txt|md|json)$/i, "text"],
];

export function fileKind(name: string): FileKind {
  return KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? "file";
}

export const FILE_ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  sheet: FileSpreadsheet,
  document: FileText,
  slides: Presentation,
  text: FileText,
  file: FileIcon,
};

const KIND_WORDS: Record<FileKind, string> = {
  image: "Image",
  pdf: "PDF",
  sheet: "Spreadsheet",
  document: "Document",
  slides: "Presentation",
  text: "Text",
  file: "File",
};

/** A file's kind, or its extension when it is none of the named ones. */
export function fileKindWord(name: string): string {
  const kind = fileKind(name);
  if (kind !== "file") return KIND_WORDS[kind];
  return name.split(".").pop()?.toUpperCase() || KIND_WORDS.file;
}

export function formatFileSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A photo from the library or the camera as a picked file. A photo with no
 * name is Photo 1, Photo 2 and on by its place, and a HEIC sent as a JPEG
 * takes the JPEG's extension.
 */
export function pickedPhoto(asset: { uri: string; fileName?: string | null; mimeType?: string | null; fileSize?: number | null }, index: number): Picked {
  const type = asset.mimeType ?? "image/jpeg";
  const extension = type === "image/png" ? "png" : type === "image/heic" ? "heic" : "jpg";
  const given = asset.fileName?.trim();
  const name = !given ? `Photo ${index + 1}.${extension}` : given.replace(/\.hei[cf]$/i, `.${extension}`);
  return { uri: asset.uri, name, type, size: asset.fileSize ?? null, photo: true };
}

/**
 * Opens the photo library, the camera or the Files app and resolves to what
 * the person picked, at most `room` of them, or to nothing when they cancel.
 * The library needs no permission, as iOS hands over only what is picked. The
 * camera asks the first time, and throws when the person has said no. Photos
 * come in the most compatible form, so a HEIC photo arrives as a JPEG.
 */
export async function pick(source: PickSource, room: number): Promise<Picked[]> {
  if (source === "photos") {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: room,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      quality: 1,
      exif: false,
    });
    return result.canceled ? [] : result.assets.slice(0, room).map(pickedPhoto);
  }
  if (source === "camera") {
    const permission = await Camera.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("Allow Sidebots to use the camera in Settings to take a photo.");
    // The keyboard goes first, so the camera has the screen.
    void KeyboardController.dismiss();
    return openCamera(room);
  }
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" });
  if (result.canceled) return [];
  return result.assets.slice(0, room).map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    type: asset.mimeType ?? "application/octet-stream",
    size: asset.size ?? null,
    photo: isImage(asset.name),
  }));
}

// The camera is a screen, whose params are only strings, so the
// request it answers waits here under an id.
type CameraRequest = { limit: number; resolve(files: Picked[]): void };
const cameraRequests = new Map<string, CameraRequest>();
let lastRequest = 0;

/** Opens the camera and resolves to the photos taken there, at most `limit`, or none when it closes without them. */
function openCamera(limit: number): Promise<Picked[]> {
  return new Promise((resolve) => {
    const id = String(++lastRequest);
    cameraRequests.set(id, { limit, resolve });
    router.push({ pathname: "/camera", params: { request: id } });
  });
}

/** How many photos the camera's request takes, or undefined once it no longer waits for an answer. */
export function cameraRequestLimit(id: string | undefined): number | undefined {
  return id ? cameraRequests.get(id)?.limit : undefined;
}

/** Answers the request the camera was opened for, once. A request already answered is left alone. */
export function settleCameraRequest(id: string | undefined, files: Picked[]): void {
  const request = id ? cameraRequests.get(id) : undefined;
  if (!id || !request) return;
  cameraRequests.delete(id);
  request.resolve(files);
}
