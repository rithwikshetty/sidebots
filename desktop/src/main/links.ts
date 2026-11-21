// Which addresses the app hands to the system browser, and which files to the
// system's own apps.

/** Whether an address is a web page's: `http` or `https`, and nothing a browser would run or open as a file. */
export function isWeb(address: string): boolean {
  return ["http:", "https:"].includes(protocolOf(address));
}

/** Whether an address is a web page's over `https`, as a sign-in page is. */
export function isSecureWeb(address: string): boolean {
  return protocolOf(address) === "https:";
}

function protocolOf(address: string): string {
  try {
    return new URL(address).protocol;
  } catch {
    return "";
  }
}

/** Whether an address is at an origin, such as `sidebots-desktop://app`. */
export function isAt(origin: string, address: string): boolean {
  return address === origin || address.startsWith(`${origin}/`);
}

// The kinds of file a click opens in the system's own app: documents to look at, which run nothing. A page opens in the browser. Office's formats that can carry macros are left out.
const DOCUMENTS = new Set([
  ...["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp"],
  ...["pdf", "txt", "md", "markdown", "csv", "tsv", "json", "log"],
  ...["docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key"],
  ...["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "opus", "mp4", "m4v", "mov", "webm"],
  ...["html", "htm"],
]);

/** Whether a file is a document to look at, by its name's extension, which the system's own app for it may open. Any other file could run something, so the person is shown it in its folder instead. */
export function isDocument(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && DOCUMENTS.has(name.slice(dot + 1).toLowerCase());
}
