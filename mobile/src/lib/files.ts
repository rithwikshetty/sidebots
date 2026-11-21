// Photos and files the person picks to send with a message.

import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { Camera } from "expo-camera";
import { KeyboardController } from "react-native-keyboard-controller";
import { File as FileIcon, FileImage, FileSpreadsheet, FileText, Presentation, type LucideIcon } from "lucide-react-native";
import { isImage, type FileKind } from "@client/files";

/** A photo or file on the phone, ready to send. `size` is in bytes, when the picker could tell. */
export type Picked = { uri: string; name: string; type: string; size: number | null; photo: boolean };
/** Where the composer's + menu picks from. */
export type PickSource = "photos" | "camera" | "files";

export const FILE_ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  sheet: FileSpreadsheet,
  document: FileText,
  slides: Presentation,
  text: FileText,
  file: FileIcon,
};

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
