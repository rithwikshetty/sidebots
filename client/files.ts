// What a message can carry in files, what kind each file is, and how a file an agent sent is named and a page among them drawn.

/** The most one message carries. */
export const MAX_FILES = 10;
export const FILE_LIMIT_NOTICE = `A message can carry up to ${MAX_FILES} files.`;
/** The most one message carries in bytes, as the server takes it. */
export const MAX_BYTES = 95 * 1024 * 1024;
export const SIZE_LIMIT_NOTICE = "A message can carry up to 95 MB of photos and files.";

/** Whether the files fit in one message. A file whose size the picker couldn't tell counts as nothing. */
export function fitsInMessage(files: { size: number | null }[]): boolean {
  return files.reduce((total, file) => total + (file.size ?? 0), 0) <= MAX_BYTES;
}

const IMAGE = /\.(jpe?g|png|gif|webp|heic|heif)$/i;

/** Whether a file is a picture the app can show, going by its name. */
export function isImage(name: string): boolean {
  return IMAGE.test(name);
}

/** Whether a file is a page the app can draw, going by its name. */
export function isPage(name: string): boolean {
  return /\.html$/i.test(name);
}

/** A sent file's own name, without the folder and the code the server puts before it. */
export function fileName(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.slice(name.indexOf("-") + 1);
}

/** A page's title from its file's name. The computer writes a dash for each space in a sent file's name, so the title reads them as spaces. */
export function pageTitle(name: string): string {
  return name.replace(/\.html$/i, "").replace(/[-_]+/g, " ");
}

/** The chat's colours as a page is given them, each a CSS colour. `link` is the colour of the page's links. */
export type PageColors = { scheme: "dark" | "light"; bg: string; ink: string; ink2: string; line: string; field: string; tint: string; link: string };

/** The style a page starts with, before its own: the chat's colours, as its defaults and as the CSS variables agents are told of, and the phone's base font. */
export function pageStyle({ scheme, bg, ink, ink2, line, field, tint, link }: PageColors): string {
  return (
    `:root{color-scheme:${scheme};--bg:${bg};--ink:${ink};--ink2:${ink2};--line:${line};--field:${field};--tint:${tint}}` +
    `html{background:var(--bg);color:var(--ink);font:17px/1.3 -apple-system,system-ui,sans-serif;-webkit-text-size-adjust:100%}body{margin:0}a{color:${link}}`
  );
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

/** A file's line under its name: its kind, and its size when it is known. */
export function fileMeta(name: string, size: number | null): string {
  return [fileKindWord(name), formatFileSize(size)].filter(Boolean).join(" · ");
}
