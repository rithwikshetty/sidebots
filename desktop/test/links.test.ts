import { expect, test } from "vitest";
import { isAt, isDocument, isSecureWeb, isWeb } from "../src/main/links.ts";

test("only an http or https address goes to the system browser", () => {
  for (const address of ["https://sidebots.app", "http://example.com/a?b=c", "HTTPS://EXAMPLE.COM"]) expect(isWeb(address)).toBe(true);
  for (const address of ["javascript:alert(1)", "file:///etc/passwd", "sidebots://pair?code=1", "data:text/html,hi", "mailto:a@b.c", "smb://server/share", "/relative", "", "https//missing-colon"]) {
    expect(isWeb(address)).toBe(false);
  }
});

test("a sign-in page opens only over https", () => {
  expect(isSecureWeb("https://accounts.google.com/o/oauth2/v2/auth?client_id=1")).toBe(true);
  expect(isSecureWeb("http://accounts.google.com/")).toBe(false);
  expect(isSecureWeb("app.sidebots:/oauth2redirect")).toBe(false);
});

test("an address is at an origin only when the origin is the whole of its start", () => {
  expect(isAt("sidebots-desktop://app", "sidebots-desktop://app")).toBe(true);
  expect(isAt("sidebots-desktop://app", "sidebots-desktop://app/chat/1?x=2")).toBe(true);
  expect(isAt("sidebots-desktop://app", "sidebots-desktop://app.evil.com/")).toBe(false);
  expect(isAt("sidebots-desktop://app", "sidebots-desktop://app@evil.com/")).toBe(false);
  expect(isAt("sidebots-desktop://app", "sidebots-page://page/a/attachments/b.html")).toBe(false);
  expect(isAt("sidebots-desktop://app", "https://example.com/sidebots-desktop://app/")).toBe(false);
});

test("a click opens only a document to look at, going by its extension, and shows any other file in its folder", () => {
  for (const name of ["Flats.png", "scan.JPEG", "Report.pdf", "notes.md", "rows.csv", "letter.docx", "budget.xlsx", "talk.pptx", "memo.rtf", "song.mp3", "clip.mov", "Flats.html", "a.b.txt"]) {
    expect(isDocument(name)).toBe(true);
  }
  for (const name of ["setup.app", "run.command", "run.sh", "x.terminal", "x.pkg", "x.dmg", "x.exe", "x.bat", "x.jar", "x.py", "x.scpt", "x.workflow", "x.webloc", "x.inetloc", "x.fileloc", "x.zip", "x.docm", "x.xlsm", "x.doc", "x.svg", "pdf", ".pdf", "Report.pdf.app", "noextension", ""]) {
    expect(isDocument(name)).toBe(false);
  }
});
