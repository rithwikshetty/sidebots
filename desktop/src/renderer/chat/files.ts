// What the chat needs to show the files a message carries and the ones the
// person adds to the next.

import { useEffect, useState } from "react";
import { File as FileIcon, FileImage, FileSpreadsheet, FileText, Presentation, type LucideIcon } from "lucide-react";
import { FILE_LIMIT_NOTICE, MAX_FILES, SIZE_LIMIT_NOTICE, fitsInMessage, isImage, type FileKind } from "@client/files.ts";
import { problem } from "../lib/alerts.ts";
import { useConnection, useOnline } from "../lib/store.ts";

/** The icon for each kind of file, as the phone draws them. */
export const FILE_ICONS: Record<FileKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  sheet: FileSpreadsheet,
  document: FileText,
  slides: Presentation,
  text: FileText,
  file: FileIcon,
};

/** Where the window loads a file a message carries, from its path in the agent's folder. */
export function attachmentUrl(agentId: string, path: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** What the server says of a sent file without sending it: whether the window can have it, and its size in bytes when it says. */
export type SentFile = { found: boolean; size: number | null };

// The answers that say nothing of a file, only that Sidebots can't be asked just now: it is out of reach or starting, or the app is about to be given its key again.
const PASSING = new Set([401, 502, 503]);

// What the server said of each sent file. A file never changes, so each is asked about once. Only the server's own word is kept, that it has the file or that it has none such: after any other answer, or none, the file is asked about again.
const sent = new Map<string, Promise<SentFile | undefined>>();

/** Asks the server about a sent file. Nothing when Sidebots couldn't be asked just now. */
function askAbout(url: string): Promise<SentFile | undefined> {
  let asking = sent.get(url);
  if (!asking) {
    asking = fetch(url, { method: "HEAD" })
      .catch(() => undefined)
      .then((answer) => {
        if (!answer?.ok && answer?.status !== 404) sent.delete(url);
        if (!answer || PASSING.has(answer.status)) return undefined;
        return { found: answer.ok, size: answer.ok ? Number(answer.headers.get("Content-Length")) || null : null };
      });
    sent.set(url, asking);
  }
  return asking;
}

/** What the server says of a sent file, as `SentFile`. Undefined until it has answered: while Sidebots can't be asked it stays so, and the file is asked about again each time Sidebots is back in reach. */
export function useSentFile(agentId: string, path: string): SentFile | undefined {
  const url = attachmentUrl(agentId, path);
  const online = useOnline();
  const { phase } = useConnection();
  const [known, setKnown] = useState<SentFile>();
  useEffect(() => {
    let showing = true;
    void askAbout(url).then((said) => showing && setKnown(said));
    return () => {
      showing = false;
    };
  }, [url, online, phase]);
  return known;
}

/** Opens a file an agent sent in the computer's own app for it, and says so in a toast when it can't. */
export function openFile(agentId: string, path: string): Promise<void> {
  return window.desktop.openFile(agentId, path).catch((failure) => problem("Couldn't open it", failure));
}

/** Saves a file an agent sent where the person chooses, and says so in a toast when it can't. */
export function saveFile(agentId: string, path: string): void {
  window.desktop.saveFile(agentId, path).catch((failure) => problem("Couldn't save it", failure));
}

/**
 * The files a message would carry once `added` join `picked`: as many as fit
 * in one message, and the words for why any were left out. Files that
 * together are too big for one message are none of them added.
 */
export function withAdded(picked: File[], added: File[]): { files: File[]; refused?: string } {
  const room = MAX_FILES - picked.length;
  const taken = added.slice(0, Math.max(room, 0));
  const sized = (files: File[]) => files.map((file) => ({ size: file.size }));
  if (!fitsInMessage(sized([...picked, ...taken]))) return { files: picked, refused: SIZE_LIMIT_NOTICE };
  return { files: [...picked, ...taken], refused: taken.length < added.length ? FILE_LIMIT_NOTICE : undefined };
}

/** An address for each picture among `files` that an image can show it from, while they are on screen. */
export function usePreviews(files: File[]): Map<File, string> {
  const [previews, setPreviews] = useState(() => new Map<File, string>());
  const key = files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");
  useEffect(() => {
    const made = new Map(files.filter((file) => isImage(file.name)).map((file) => [file, URL.createObjectURL(file)]));
    setPreviews(made);
    return () => made.forEach((url) => URL.revokeObjectURL(url));
    // The files are the same ones for as long as their names, sizes and times are.
  }, [key]);
  return previews;
}
