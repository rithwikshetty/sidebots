import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { expect, test } from "vitest";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "../../server/src/contract.ts";
import { PAGE_POLICY, apiAddress, attachmentAddress, attachmentName, createHandlers, dressed, fileUnder, madeByWindow, pageAddress, pageTheme, sendsIntoWindow, tagged, windowPolicy } from "../src/main/protocol.ts";

const THEME = "scheme=dark&bg=%23000000&ink=%23FFFFFF&ink2=%2398989F&line=%232C2C2E&field=%231C1C1E&tint=%232A62D4&link=%237EAAFF";
const PAGE = `sidebots-page://page/agent-1/attachments/Flats.html?${THEME}`;

/** The handlers over a server that answers what `answer` says, with the window's files in a folder of the test's own. */
function setup(answer: (url: string, init: RequestInit) => Response | Promise<Response> = () => Response.json([]), key: string | undefined = "the-key") {
  const files = mkdtempSync(join(tmpdir(), "sidebots-desktop-test-"));
  mkdirSync(join(files, "assets"));
  writeFileSync(join(files, "index.html"), "<!doctype html><title>Sidebots</title>");
  writeFileSync(join(files, "assets", "app.js"), "console.log(1)");
  const calls: { url: string; init: RequestInit & { duplex?: "half" } }[] = [];
  let troubles = 0;
  const handlers = createHandlers({
    port: 4391,
    key: () => key,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer(url, init);
    },
    files,
    trouble: () => troubles++,
  });
  return { handlers, calls, troubles: () => troubles };
}

/** A request as it reaches the handler: marked by the main process with whether the window's own document made it. */
const fromWindow = (url: string, init: RequestInit & { duplex?: "half" } = {}) => new Request(url, { ...init, headers: tagged(Object.fromEntries(new Headers(init.headers)), true) });

test("a path under /api/ is the server's path, on the server's own address whatever the path holds", () => {
  const at = (address: string) => apiAddress(new URL(address), 4391);
  expect(at("sidebots-desktop://app/api/agents")).toBe("http://127.0.0.1:4391/agents");
  expect(at("sidebots-desktop://app/api/agents/a-1/messages?before=m-2&x=%2F")).toBe("http://127.0.0.1:4391/agents/a-1/messages?before=m-2&x=%2F");
  expect(at("sidebots-desktop://app/api/search?text=a%20b")).toBe("http://127.0.0.1:4391/search?text=a%20b");
  expect(at("sidebots-desktop://app/api//evil.com/x")).toBe("http://127.0.0.1:4391//evil.com/x");
  expect(at("sidebots-desktop://app/api/@evil.com/x")).toBe("http://127.0.0.1:4391/@evil.com/x");
  expect(at("sidebots-desktop://app/api/../assets/app.js")).toBeUndefined();
  expect(at("sidebots-desktop://app/api")).toBeUndefined();
  expect(at("sidebots-desktop://app/apis/agents")).toBeUndefined();
  expect(at("sidebots-desktop://app/")).toBeUndefined();
  expect(at("sidebots-desktop://other/api/agents")).toBeUndefined();
});

test("the window's own document calls the server through the app, which adds the key and the contract version", async () => {
  const { handlers, calls } = setup(() => Response.json([{ name: "Maya" }]));
  const answer = await handlers.app(fromWindow("sidebots-desktop://app/api/agents", { headers: { Authorization: "Bearer made-up", Cookie: "a=b", Accept: "application/json" } }));
  expect(await answer.json()).toEqual([{ name: "Maya" }]);
  expect(calls[0].url).toBe("http://127.0.0.1:4391/agents");
  const sent = new Headers(calls[0].init.headers);
  expect(sent.get("Authorization")).toBe("Bearer the-key");
  expect(sent.get(CONTRACT_HEADER)).toBe(String(CONTRACT_VERSION));
  expect(sent.get("Accept")).toBe("application/json");
  expect(sent.get("Cookie")).toBeNull();
  expect(sent.get("sidebots-from-window")).toBeNull();
});

test("nothing but the window's own document may call the server", async () => {
  const { handlers, calls } = setup();
  const url = "sidebots-desktop://app/api/agents";
  // A frame inside the window, a move to the address, and a request that says for itself that the window made it.
  expect((await handlers.app(new Request(url, { headers: tagged({}, false) }))).status).toBe(403);
  expect((await handlers.app(new Request(url))).status).toBe(403);
  expect(tagged({ "Sidebots-From-Window": "yes", Accept: "*/*" }, false)).toEqual({ Accept: "*/*", "sidebots-from-window": "no" });
  expect((await handlers.app(new Request(url, { method: "DELETE", headers: tagged({ "Sidebots-From-Window": "yes" }, false) }))).status).toBe(403);
  expect(calls).toEqual([]);
  expect((await handlers.app(fromWindow(url))).status).toBe(200);
});

test("a request is the window's own only when its top document made it", () => {
  const top = {};
  for (const resourceType of ["xhr", "image", "media", "script", "other"]) expect(madeByWindow({ frame: top, resourceType }, top)).toBe(true);
  // A move of the window itself to an address, a request of a frame inside the window, and a request no frame is named for.
  expect(madeByWindow({ frame: top, resourceType: "mainFrame" }, top)).toBe(false);
  expect(madeByWindow({ frame: {}, resourceType: "xhr" }, top)).toBe(false);
  expect(madeByWindow({ frame: null, resourceType: "xhr" }, top)).toBe(false);
  expect(madeByWindow({ resourceType: "xhr" }, top)).toBe(false);
});

test("an answer that sends its request on into one of the app's schemes from another is told apart, however the address is spelled", () => {
  const from = (url: string, location: string) => sendsIntoWindow(url, { Location: [location] });
  expect(from("https://example.com/chart.png", "sidebots-desktop://app/api/events")).toBe(true);
  expect(sendsIntoWindow("https://example.com/chart.png", { location: ["sidebots-desktop://app"] })).toBe(true);
  // Spellings a browser reads as the window's origin, which don't read the same as text: the scheme's and the host's case, a port, a name before the host, slashes missing, doubled or backwards, and spaces, tabs and line ends around and inside the scheme.
  for (const location of [
    "SIDEBOTS-DESKTOP://app/api/events",
    "Sidebots-Desktop://APP/api/events",
    "sidebots-desktop://app:0/api/events",
    "sidebots-desktop://app:443/api/events",
    "sidebots-desktop://someone:secret@app/api/events",
    "sidebots-desktop:/app/api/events",
    "sidebots-desktop:app/api/events",
    "sidebots-desktop:///app/api/events",
    "sidebots-desktop:\\\\app\\api\\events",
    "sidebots-desktop://app\\api/events",
    "sidebots-desktop://app:99999/api/events",
    "sidebots-desktop://a b/api/events",
    "  sidebots-desktop://app/api/events",
    "\tside\nbots-desk\rtop://app/api/events",
    "sidebots-desktop://other/api/events",
    "sidebots-desktop:",
  ]) {
    expect(from("https://example.com/chart.png", location), location).toBe(true);
  }
  // An agent's page is served to the window's own frames alone, so nothing is sent on to it either.
  expect(from("https://example.com/chart.png", "sidebots-page://page/a/attachments/b.html")).toBe(true);
  expect(from("https://example.com/chart.png", "SIDEBOTS-PAGE://open/a-token?to=https%3A%2F%2Fexample.com%2F")).toBe(true);
  expect(from("sidebots-page://page/a/attachments/b.html", "sidebots-desktop://app/api/events")).toBe(true);
  expect(from("sidebots-desktop://app/api/agents", "sidebots-page://page/a/attachments/b.html")).toBe(true);
  // Sent on elsewhere, to an address read against its own, or not sent on at all.
  for (const location of ["/other.png", "//app/api/events", "other.png?to=sidebots-desktop://app/", "https://example.org/sidebots-desktop://app/", "sidebots-desktop//app/api/events", "sidebots-desktops://app/", "x-sidebots-desktop://app/", "sidebots://pair?code=1", ""]) {
    expect(from("https://example.com/chart.png", location), location).toBe(false);
  }
  expect(sendsIntoWindow("https://example.com/chart.png", { "Content-Type": ["image/png"] })).toBe(false);
  expect(sendsIntoWindow("https://example.com/chart.png")).toBe(false);
  // The window's origin sends its own requests on within itself, as the server's answers may.
  expect(from("sidebots-desktop://app/api/agents", "sidebots-desktop://app/api/agents/")).toBe(false);
  expect(from("sidebots-desktop://app/api/agents", "/api/agents/")).toBe(false);
});

test("a request's body goes to the server as a stream, and the server's answer comes back as it is", async () => {
  const served = new Response("event: ping\ndata:\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const { handlers, calls } = setup((url) => (url.endsWith("/events") ? served : Response.json({ id: "m-1" }, { status: 201 })));
  const posted = await handlers.app(fromWindow("sidebots-desktop://app/api/agents/a-1/messages", { method: "POST", body: "body=hello", duplex: "half", headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
  expect(posted.status).toBe(201);
  expect(calls[0].init.method).toBe("POST");
  expect(calls[0].init.duplex).toBe("half");
  expect(await new Response(calls[0].init.body).text()).toBe("body=hello");
  expect(new Headers(calls[0].init.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
  expect(await handlers.app(fromWindow("sidebots-desktop://app/api/events"))).toBe(served);
  expect(calls[1].init.body).toBeUndefined();
});

test("an event stream's connection to the server ends when the window opens a newer one, or gives the stream up", async () => {
  const { handlers, calls } = setup(() => new Response("event: ping\ndata:\n\n"));
  await handlers.app(fromWindow("sidebots-desktop://app/api/events"));
  await handlers.app(fromWindow("sidebots-desktop://app/api/agents"));
  const first = calls[0].init.signal!;
  expect(first.aborted).toBe(false);
  expect(calls[1].init.signal).toBeUndefined();

  await handlers.app(fromWindow("sidebots-desktop://app/api/events"));
  const second = calls[2].init.signal!;
  expect(first.aborted).toBe(true);
  expect(second.aborted).toBe(false);

  // The window loads again or closes.
  handlers.endEvents();
  expect(second.aborted).toBe(true);
});

test("a server that refuses the key or can't be reached has the app look at its connection again", async () => {
  const refused = setup(() => Response.json({ error: "This device isn't paired with this computer." }, { status: 401 }));
  expect((await refused.handlers.app(fromWindow("sidebots-desktop://app/api/agents"))).status).toBe(401);
  expect(refused.troubles()).toBe(1);

  const stopped = setup(() => Promise.reject(new Error("net::ERR_CONNECTION_REFUSED")));
  expect((await stopped.handlers.app(fromWindow("sidebots-desktop://app/api/agents"))).status).toBe(502);
  expect(stopped.troubles()).toBe(1);

  const unpaired = setup(undefined, "");
  expect((await unpaired.handlers.app(fromWindow("sidebots-desktop://app/api/agents"))).status).toBe(503);
  expect(unpaired.calls).toEqual([]);
});

test("the window's files are served with their types and the window's policy, and a path that names no file is the window's page", async () => {
  const { handlers } = setup();
  const script = await handlers.app(new Request("sidebots-desktop://app/assets/app.js"));
  expect(script.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  expect(await script.text()).toBe("console.log(1)");
  for (const path of ["/", "/chat/agent-1", "/index.html"]) {
    const page = await handlers.app(new Request(`sidebots-desktop://app${path}`));
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Content-Security-Policy")).toBe(windowPolicy());
    expect(await page.text()).toContain("<title>Sidebots</title>");
  }
  expect((await handlers.app(new Request("sidebots-desktop://app/assets/missing.js"))).status).toBe(404);
  expect((await handlers.app(new Request("sidebots-desktop://app/", { method: "POST", body: "x" }))).status).toBe(405);
  expect((await handlers.app(new Request("sidebots-desktop://other/"))).status).toBe(404);
});

test("no path leads out of the folder the window's files are in", () => {
  expect(fileUnder("/app/renderer", "/assets/app.js")).toBe("/app/renderer/assets/app.js");
  expect(fileUnder("/app/renderer", "/")).toBe("/app/renderer");
  expect(fileUnder("/app/renderer", "/%2e%2e/%2e%2e/etc/passwd")).toBeUndefined();
  expect(fileUnder("/app/renderer", "/..%2f..%2fetc%2fpasswd")).toBeUndefined();
  expect(fileUnder("/app/renderer", "/../renderer-other/x")).toBeUndefined();
  expect(fileUnder("/app/renderer", "/a%00.js")).toBeUndefined();
  expect(fileUnder("/app/renderer", "/%E0%A4%A")).toBeUndefined();
});

test("the window's policy lets it run its own code, call its own origin and frame agents' pages, and the Vite server only in development", () => {
  expect(windowPolicy()).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-src sidebots-page:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  const development = windowPolicy("http://localhost:5183");
  expect(development).toContain("script-src 'self' 'unsafe-inline';");
  expect(development).toContain("connect-src 'self' http://localhost:5183 ws://localhost:5183;");
});

test("only an agent's .html attachment is a page", () => {
  const at = (address: string) => pageAddress(new URL(address), 4391);
  expect(at(PAGE)).toBe("http://127.0.0.1:4391/agents/agent-1/attachments/Flats.html");
  expect(at("sidebots-page://page/agent-1/attachments/a.b-c_d.HTML")).toBe("http://127.0.0.1:4391/agents/agent-1/attachments/a.b-c_d.HTML");
  for (const address of [
    "sidebots-page://page/agent-1/attachments/photo.png",
    "sidebots-page://page/agent-1/attachments/notes.html.pdf",
    "sidebots-page://page/agent-1/attachments/.html",
    "sidebots-page://page/agent-1/memory/secrets.html",
    "sidebots-page://page/agent-1/attachments/a/b.html",
    "sidebots-page://page/agent-1/attachments/..%2Fx.html",
    "sidebots-page://page/agent%2F1/attachments/x.html",
    "sidebots-page://page/attachments/x.html",
    "sidebots-page://other/agent-1/attachments/x.html",
  ]) {
    expect(at(address)).toBeUndefined();
  }
  expect(attachmentAddress(4391, "agent-1", "attachments/report.pdf")).toBe("http://127.0.0.1:4391/agents/agent-1/attachments/report.pdf");
  expect(attachmentAddress(4391, "agent-1", "attachments/../../x")).toBeUndefined();
  expect(attachmentAddress(4391, "../agent-1", "attachments/x.pdf")).toBeUndefined();
});

test("a page's colours are each #RRGGBB, and nothing else gets into its styles", () => {
  expect(pageTheme(new URLSearchParams(THEME))).toBe(
    ":root{color-scheme:dark;--bg:#000000;--ink:#FFFFFF;--ink2:#98989F;--line:#2C2C2E;--field:#1C1C1E;--tint:#2A62D4}" +
      "html{background:var(--bg);color:var(--ink);font:17px/1.3 -apple-system,system-ui,sans-serif;-webkit-text-size-adjust:100%}body{margin:0}a{color:#7EAAFF}",
  );
  const withThe = (name: string, value: string) => {
    const asked = new URLSearchParams(THEME);
    asked.set(name, value);
    return pageTheme(asked);
  };
  expect(withThe("scheme", "light")).toContain("color-scheme:light");
  for (const value of ["red", "#FFF", "#GGGGGG", "#00000000", "#000000}</style><script>alert(1)</script>", "#000000;--x:url(https://evil)", ""]) expect(withThe("bg", value)).toBeUndefined();
  expect(withThe("link", "javascript:alert(1)")).toBeUndefined();
  expect(withThe("scheme", "dark}html{display:none")).toBeUndefined();
  expect(pageTheme(new URLSearchParams("scheme=dark&bg=%23000000"))).toBeUndefined();
});

test("an agent's page is answered with the theme before its own content, under the page's policy", async () => {
  const html = "<!DOCTYPE html>\n<html><head><style>h1{color:var(--tint)}</style></head><body><h1>Flats</h1></body></html>";
  const { handlers, calls } = setup(() => new Response(html, { headers: { "Content-Type": "application/octet-stream" } }));
  const answer = await handlers.page(new Request(PAGE));
  expect(answer.status).toBe(200);
  expect(calls[0].url).toBe("http://127.0.0.1:4391/agents/agent-1/attachments/Flats.html");
  expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer the-key");
  expect(answer.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(answer.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(answer.headers.get("Content-Security-Policy")).toBe(PAGE_POLICY);
  expect(PAGE_POLICY).toBe(
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors sidebots-desktop://app; sandbox allow-scripts",
  );

  const text = await answer.text();
  expect(text.startsWith('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style id="sidebots">:root{color-scheme:dark;--bg:#000000;')).toBe(true);
  expect(text.endsWith(html)).toBe(true);
  expect(text.indexOf("--tint:#2A62D4")).toBeLessThan(text.indexOf(html));
  // The page tells the window its height, and the app's script opens no window.
  expect(text).toContain('parent.postMessage({sidebots:"height",height:h},"sidebots-desktop://app")');
  expect(text).not.toContain("window.open");
  // A page with no doctype of its own is given none.
  expect(dressed("<h1>Hi</h1>", "x", "a-token").startsWith("<meta")).toBe(true);
});

/** A link in a page, or something inside one, as far as the app's script looks at it. */
class Element {
  readonly href: string | null;
  readonly inside: Element | undefined;
  constructor(href: string | null, inside?: Element) {
    this.href = href;
    this.inside = inside;
  }
  closest(): Element | null {
    return this.href !== null ? this : (this.inside?.closest() ?? null);
  }
  getAttribute(): string | null {
    return this.href;
  }
}

/** A click, the person's own when `isTrusted`. */
class Event {
  prevented = false;
  readonly isTrusted: boolean;
  readonly on: Element;
  constructor(isTrusted: boolean, on: Element) {
    this.isTrusted = isTrusted;
    this.on = on;
  }
  get target(): Element {
    return this.on;
  }
  preventDefault(): void {
    this.prevented = true;
  }
}

/**
 * Runs the app's script from a page's text as a browser would at the start of
 * the page at `at`. `click` is what the script does with a click, `moved` is
 * every address the script moved the frame to, and `run` runs a script of the
 * page's own after it.
 */
function inPage(text: string, at: string) {
  const script = /<script>(.*?)<\/script>/s.exec(text)![1];
  const heard: Record<string, (event: Event) => void> = {};
  const moved: string[] = [];
  let removed = 0;
  const document = {
    documentElement: { scrollHeight: 300, clientHeight: 200, getBoundingClientRect: () => ({ height: 300 }) },
    currentScript: { remove: () => removed++ },
    addEventListener: (name: string, listener: (event: Event) => void) => void (heard[name] = listener),
  };
  const location = {
    get href() {
      return at;
    },
    set href(to: string) {
      moved.push(to);
    },
  };
  const posted: unknown[] = [];
  class ResizeObserver {
    observe(): void {}
  }
  const context = createContext({ document, location, window: { addEventListener: () => undefined }, parent: { postMessage: (...sent: unknown[]) => posted.push(sent) }, Event, Element, URL, ResizeObserver });
  runInContext(script, context);
  return { click: (event: Event) => (heard.click(event), event), moved, posted, removed: () => removed, listener: () => String(heard.click), run: (own: string) => runInContext(own, context) };
}

test("a link the person clicks in a page is opened by the app, which knows the page by the token it made for it", async () => {
  const { handlers } = setup(() => new Response("<a href='https://example.com/'>A link</a>"));
  const text = await (await handlers.page(new Request(PAGE))).text();
  const page = inPage(text, PAGE);
  expect(page.removed()).toBe(1);
  expect(page.posted).toEqual([[{ sidebots: "height", height: 300 }, "sidebots-desktop://app"]]);

  const clicked = page.click(new Event(true, new Element(null, new Element("https://example.com/a b?x=1&y=2#top"))));
  expect(clicked.prevented).toBe(true);
  expect(page.moved).toHaveLength(1);
  expect(page.moved[0]).toMatch(/^sidebots-page:\/\/open\/[0-9a-f]{32}\?to=https%3A%2F%2Fexample\.com%2Fa%2520b%3Fx%3D1%26y%3D2%23top$/);
  expect(handlers.pageLink(page.moved[0])).toBe("https://example.com/a%20b?x=1&y=2#top");

  // The token is the page's alone, the app knows no other, and no other address asks for a link.
  const token = new URL(page.moved[0]).pathname.slice(1);
  expect(text.split(token)).toHaveLength(2);
  expect(page.listener()).not.toContain(token);
  const other = await (await handlers.page(new Request(PAGE))).text();
  expect(other).not.toContain(token);
  expect(handlers.pageLink(`sidebots-page://open/${"0".repeat(32)}?to=https%3A%2F%2Fexample.com%2F`)).toBeUndefined();
  expect(handlers.pageLink("sidebots-page://open/?to=https%3A%2F%2Fexample.com%2F")).toBeUndefined();
  expect(handlers.pageLink(`sidebots-page://page/${token}?to=https%3A%2F%2Fexample.com%2F`)).toBeUndefined();
  expect(handlers.pageLink(`sidebots-page://open.example/${token}?to=https%3A%2F%2Fexample.com%2F`)).toBeUndefined();
  expect(handlers.pageLink(`sidebots-desktop://open/${token}?to=https%3A%2F%2Fexample.com%2F`)).toBeUndefined();
  expect(handlers.pageLink(`https://open/${token}?to=https%3A%2F%2Fexample.com%2F`)).toBeUndefined();
  expect(handlers.pageLink(`sidebots-page://open/${token}/x?to=https%3A%2F%2Fexample.com%2F`)).toBeUndefined();
  expect(handlers.pageLink(`sidebots-page://open/${token}`)).toBeUndefined();
  expect(handlers.pageLink("not an address")).toBeUndefined();
  // Whatever the link is, it is handed over as it is: what may open is the window's to say.
  expect(handlers.pageLink(`sidebots-page://open/${token}?to=file%3A%2F%2F%2Fetc%2Fhosts`)).toBe("file:///etc/hosts");
});

test("only the person's own click on a link to a web page asks the app to open it", () => {
  const page = inPage(dressed("", "x", "a-token"), PAGE);
  const link = new Element("https://example.com/");
  // A click the page's own script made.
  expect(page.click(new Event(false, link)).prevented).toBe(false);
  // A click that isn't on a link, and one on a link to a place in the page itself, which goes there.
  expect(page.click(new Event(true, new Element(null))).prevented).toBe(false);
  expect(page.click(new Event(true, new Element("#prices"))).prevented).toBe(false);
  // A link to anything but a web page goes nowhere.
  for (const href of ["mailto:someone@example.com", "file:///etc/hosts", "javascript:alert(1)", "sidebots://pair?code=1", "sidebots-desktop://app/api/agents", "other.html", "//example.com/", "/api/events", "", "https://"]) {
    expect(page.click(new Event(true, new Element(href))).prevented).toBe(true);
  }
  expect(page.moved).toEqual([]);
  expect(page.click(new Event(true, new Element("HTTP://Example.com/x"))).prevented).toBe(true);
  expect(page.moved).toEqual(["sidebots-page://open/a-token?to=http%3A%2F%2Fexample.com%2Fx"]);
});

test("nothing a page's own scripts change afterwards changes what the app's script does with a click", () => {
  const page = inPage(dressed("", "x", "a-token"), PAGE);
  const closest = Element.prototype.closest;
  const kept = [Object.getOwnPropertyDescriptor(Event.prototype, "target")!, Object.getOwnPropertyDescriptor(URL.prototype, "href")!, URL.parse] as const;
  try {
    // The page makes every click look like one on a link of its choosing, every address a web page's, and every link the one it wants opened.
    const forged = new Element("https://evil.example/");
    Element.prototype.closest = () => forged;
    Object.defineProperty(Event.prototype, "target", { get: () => forged });
    Object.defineProperty(URL.prototype, "href", { get: () => "https://evil.example/" });
    URL.parse = () => new URL("https://evil.example/");
    page.run(`String.prototype.startsWith = function () { return true; };
      encodeURIComponent = function () { return "https%3A%2F%2Fevil.example%2F"; };
      Function.prototype.call = function () { return "https://evil.example/"; };
      Function.prototype.bind = function () { return function () { return "https://evil.example/"; }; };
      Object.getOwnPropertyDescriptor = function () { return { get: function () { return "https://evil.example/"; } }; };`);
    expect(page.click(new Event(true, new Element(null))).prevented).toBe(false);
    expect(page.click(new Event(false, new Element("https://example.com/"))).prevented).toBe(false);
    expect(page.click(new Event(true, new Element("mailto:someone@example.com"))).prevented).toBe(true);
    expect(page.moved).toEqual([]);
    page.click(new Event(true, new Element("https://example.com/")));
    expect(page.moved).toEqual(["sidebots-page://open/a-token?to=https%3A%2F%2Fexample.com%2F"]);
  } finally {
    Element.prototype.closest = closest;
    Object.defineProperty(Event.prototype, "target", kept[0]);
    Object.defineProperty(URL.prototype, "href", kept[1]);
    URL.parse = kept[2];
  }
});

test("the app knows the tokens of the pages it served lately, and no more", async () => {
  const { handlers } = setup(() => new Response("<p>A page</p>"));
  const asked = async () => {
    const page = inPage(await (await handlers.page(new Request(PAGE))).text(), PAGE);
    return page.click(new Event(true, new Element("https://example.com/"))) && page.moved[0];
  };
  const first = await asked();
  const second = await asked();
  for (let served = 2; served < 256; served++) await handlers.page(new Request(PAGE));
  expect(handlers.pageLink(first)).toBe("https://example.com/");
  await handlers.page(new Request(PAGE));
  expect(handlers.pageLink(first)).toBeUndefined();
  expect(handlers.pageLink(second)).toBe("https://example.com/");
});

test("a page is refused when it isn't an .html attachment, has no colours, isn't on the server, or the app holds no key", async () => {
  const { handlers, calls } = setup(() => Response.json({ error: "No such file." }, { status: 404 }));
  expect((await handlers.page(new Request(`sidebots-page://page/agent-1/attachments/photo.png?${THEME}`))).status).toBe(404);
  expect((await handlers.page(new Request(PAGE, { method: "POST", body: "x" }))).status).toBe(404);
  expect((await handlers.page(new Request("sidebots-page://page/agent-1/attachments/Flats.html"))).status).toBe(400);
  expect((await handlers.page(new Request(PAGE.replace("%23000000", "red")))).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await handlers.page(new Request(PAGE))).status).toBe(404);
  expect((await setup(undefined, "").handlers.page(new Request(PAGE))).status).toBe(503);
});

test("a downloaded file is named by the attachment's own name, which never holds a folder", () => {
  expect(attachmentName("attachments/1a2b3c4d-Report.pdf")).toBe("Report.pdf");
  expect(attachmentName("attachments/1a2b3c4d-Q3-plan.v2.csv")).toBe("Q3-plan.v2.csv");
  expect(attachmentName("attachments/Report.pdf")).toBe("Report.pdf");
  expect(attachmentName("attachments/1a2b3c4d-..")).toBe("1a2b3c4d-..");
  expect(attachmentName("attachments/1a2b3c4d-")).toBe("1a2b3c4d-");
  for (const path of ["attachments/../secret", "attachments/a/b.pdf", "../attachments/a.pdf", "attachments/.hidden", "attachments/", "other/a.pdf", "/etc/passwd", "attachments/a\\b.pdf"]) {
    expect(attachmentName(path)).toBeUndefined();
  }
});
