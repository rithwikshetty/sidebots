// The two schemes the window loads from. `sidebots-desktop://app` is the
// window's own origin: its files, and under `/api/` the server, which the main
// process reaches with the app's key so the window never holds it.
// `sidebots-page://page` serves a page an agent sent, which is drawn in a
// frame that can reach neither the window nor the server.
// `sidebots-page://open` is where a page's frame is moved to ask the app to
// open a link the person clicked in it, and nothing is served there.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { type PageColors, pageStyle } from "../../../client/files.ts";
import { CONTRACT_HEADER, CONTRACT_VERSION } from "../../../server/src/contract.ts";
import { NOT_RUNNING } from "../bridge.ts";
import { isAt } from "./links.ts";

export const APP_SCHEME = "sidebots-desktop";
export const PAGE_SCHEME = "sidebots-page";
export const APP_ORIGIN = `${APP_SCHEME}://app`;
export const PAGE_ORIGIN = `${PAGE_SCHEME}://page`;
export const OPEN_ORIGIN = `${PAGE_SCHEME}://open`;

/** What each scheme may do, as Electron is told before the app is ready. */
export const SCHEMES = [
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  { scheme: PAGE_SCHEME, privileges: { standard: true, secure: true } },
];

/**
 * The header the main process puts on every request to the window's origin,
 * saying whether the window's own document made it. A request arrives at the
 * handler without its frame, so `tagged` names it on the way in, in place of
 * anything the request said about itself.
 */
const FROM_WINDOW = "sidebots-from-window";

/** A request's headers with the tag that says whether the window's own top document made the request, and not a frame inside it or a move to another address. */
export function tagged(headers: Record<string, string>, fromWindow: boolean): Record<string, string> {
  const kept = Object.entries(headers).filter(([name]) => name.toLowerCase() !== FROM_WINDOW);
  return Object.fromEntries([...kept, [FROM_WINDOW, fromWindow ? "yes" : "no"]]);
}

/**
 * Whether the window's own top document made a request. `frame` is the frame
 * Electron names as the request's, and `top` is the window's top frame. A
 * request of the top frame's that moves it to another address is not one of
 * its document's.
 */
export function madeByWindow(request: { frame?: object | null; resourceType: string }, top: object): boolean {
  return request.frame === top && request.resourceType !== "mainFrame";
}

/**
 * The scheme an address names, in lower case, read as a browser reads one:
 * past the spaces and control characters before it and the tabs and line ends
 * inside it. Nothing for an address that names none, which is one read against
 * the address it was found at.
 */
function schemeOf(address: string): string | undefined {
  return /^[a-z][a-z0-9+.-]*(?=:)/i.exec(address.replace(/^[\0- ]+/, "").replace(/[\t\n\r]/g, ""))?.[0].toLowerCase();
}

/**
 * Whether an answer sends its request on into one of the app's two schemes
 * from another scheme. Nothing the app loads does, so every spelling of such
 * an address is told by its scheme alone. `headers` are the answer's, by name
 * as the server wrote it.
 */
export function sendsIntoWindow(url: string, headers: Record<string, string[]> = {}): boolean {
  const location = Object.entries(headers).find(([name]) => name.toLowerCase() === "location")?.[1][0];
  const from = schemeOf(url);
  const to = location === undefined ? undefined : (schemeOf(location) ?? from);
  return to !== from && (to === APP_SCHEME || to === PAGE_SCHEME);
}

// What the browser says about a request that is the window's own business, or that the request passed on says for itself. A request passed on with its origin is one the main process would hold to the browser's rules between origins.
const DROPPED = ["host", "origin", "referer", "connection", "content-length", "accept-encoding", "cookie", FROM_WINDOW];

/** A request's headers as they are passed on. */
function passedOn(request: Headers): Headers {
  const headers = new Headers(request);
  for (const name of DROPPED) headers.delete(name);
  return headers;
}

/** The server's address for a request under `/api/`, or nothing for any other. The path is set on the server's own address, so no path can name another host. */
export function apiAddress(url: URL, port: number): string | undefined {
  if (url.host !== "app" || !url.pathname.startsWith("/api/")) return undefined;
  const address = new URL(`http://127.0.0.1:${port}`);
  address.pathname = url.pathname.slice("/api".length);
  address.search = url.search;
  return address.href;
}

/** What the server is sent for a request of the window's: the request's own headers, with the app's key and the contract version it speaks. */
export function apiHeaders(request: Headers, key: string): Headers {
  const headers = passedOn(request);
  headers.set("Authorization", `Bearer ${key}`);
  headers.set(CONTRACT_HEADER, String(CONTRACT_VERSION));
  return headers;
}

const AGENT_ID = /^[\w-]+$/;
// A stored attachment's path in its agent's folder, as the server names one.
const ATTACHMENT = /^attachments\/[\w-][\w.-]*$/;

/** The server's address for a file an agent sent, from its path in the agent's folder, or nothing when it isn't one. */
export function attachmentAddress(port: number, agentId: string, path: string): string | undefined {
  return AGENT_ID.test(agentId) && ATTACHMENT.test(path) ? `http://127.0.0.1:${port}/agents/${agentId}/${path}` : undefined;
}

/**
 * A stored attachment's own name, as it was sent, without the code the server
 * puts before it, or nothing when `path` isn't an attachment's. It never holds
 * a folder, so a file can be written by it. A name that would be only dots
 * keeps the server's code.
 */
export function attachmentName(path: string): string | undefined {
  if (!ATTACHMENT.test(path)) return undefined;
  const stored = path.slice("attachments/".length);
  const own = stored.replace(/^[0-9a-f]{8}-/, "");
  return /^\.*$/.test(own) ? stored : own;
}

/** The server's address for the page at `sidebots-page://page/<agent>/<attachment path>`, or nothing when it names no `.html` attachment. */
export function pageAddress(url: URL, port: number): string | undefined {
  const [, agentId, ...path] = url.pathname.split("/");
  if (url.host !== "page" || !agentId || !/\.html$/i.test(url.pathname)) return undefined;
  return attachmentAddress(port, agentId, path.join("/"));
}

const COLOR = /^#[0-9a-f]{6}$/i;
const COLORS = ["bg", "ink", "ink2", "line", "field", "tint", "link"] as const;

/**
 * What a page is given before its own content: the chat's colours, as its
 * defaults and as CSS variables for its own styles, and the phone's base
 * font. The window sends the colours with the page's address: `scheme` is
 * `dark` or `light`, and `bg`, `ink`, `ink2`, `line`, `field`, `tint` and
 * `link` are each #RRGGBB. Nothing when any is missing or isn't a colour.
 */
export function pageTheme(asked: URLSearchParams): string | undefined {
  const scheme = asked.get("scheme");
  const colors = Object.fromEntries(COLORS.map((name) => [name, asked.get(name) ?? ""]));
  if ((scheme !== "dark" && scheme !== "light") || !COLORS.every((name) => COLOR.test(colors[name]))) return undefined;
  return pageStyle({ scheme, ...colors } as PageColors);
}

/**
 * The app's own script, which runs in a page before anything of the page's.
 * It tells the window how tall the page's content is, now and as it changes.
 * A click of the person's on a link to a web page asks the app to open it:
 * the script moves the frame to an address that holds the link and `token`,
 * a move the main process stops and reads. The page's own scripts can't ask
 * the same. They never see the token, since the script takes its own element
 * out of the page as it starts and keeps the token where nothing of theirs
 * reaches, and a click they make isn't one the browser trusts. Everything the
 * script calls for a click it took hold of as it started, so nothing they
 * change afterwards changes what it does. A link to a place in the page
 * itself goes there.
 */
function pageScript(token: string): string {
  return (
    `(function(){"use strict";var d=document,r=d.documentElement,last,token=${JSON.stringify(token)},` +
    `own=Function.prototype.bind.bind(Function.prototype.call),got=function(of,name){return own(Object.getOwnPropertyDescriptor(of.prototype,name).get)},` +
    `target=got(Event,"target"),prevent=own(Event.prototype.preventDefault),closest=own(Element.prototype.closest),attribute=own(Element.prototype.getAttribute),` +
    `parse=URL.parse,href=got(URL,"href"),starts=own(String.prototype.startsWith),encode=encodeURIComponent;d.currentScript.remove();` +
    `function tell(){var h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(h>0&&h!==last){last=h;parent.postMessage({sidebots:"height",height:h},${JSON.stringify(APP_ORIGIN)});}}` +
    `new ResizeObserver(tell).observe(r);d.addEventListener("DOMContentLoaded",function(){if(d.body)new ResizeObserver(tell).observe(d.body);tell();});window.addEventListener("load",tell);tell();` +
    `d.addEventListener("click",function(e){if(!e.isTrusted)return;var a=closest(target(e),"a[href]"),to=a&&attribute(a,"href");if(!a||to[0]==="#")return;prevent(e);a=parse(to,location.href);to=a?href(a):"";` +
    `if(starts(to,"http://")||starts(to,"https://"))location.href=${JSON.stringify(`${OPEN_ORIGIN}/`)}+token+"?to="+encode(to);},true);` +
    `})();`
  );
}

/**
 * An agent's page as the frame is given it: the theme and the app's script,
 * which holds `token`, then the page's own text. A page that starts with a
 * doctype keeps one at its start, so it is laid out in the mode it asked for.
 */
export function dressed(html: string, theme: string, token: string): string {
  const doctype = /^\s*<!doctype/i.test(html) ? "<!doctype html>" : "";
  return `${doctype}<meta name="viewport" content="width=device-width,initial-scale=1"><style id="sidebots">${theme}</style><script>${pageScript(token)}</script>${html}`;
}

/**
 * What a page may do: run its own scripts and styles, and load images and
 * fonts from the web. It can't call anything, send a form, load a frame,
 * open a window or be drawn anywhere but in the window. `sandbox` closes it
 * off from the window and every other page even where a frame forgets to.
 */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "font-src https: data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  `frame-ancestors ${APP_ORIGIN}`,
  "sandbox allow-scripts",
].join("; ");

/**
 * What the window's own documents may do: run the app's scripts and styles,
 * show images, call their own origin, and frame agents' pages. `devServer` is
 * where Vite serves the window in development, which needs its inline script
 * and its socket for live updates.
 */
export function windowPolicy(devServer?: string): string {
  return [
    "default-src 'self'",
    `script-src 'self'${devServer ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `connect-src 'self'${devServer ? ` ${devServer} ${devServer.replace(/^http/, "ws")}` : ""}`,
    `frame-src ${PAGE_SCHEME}:`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** The file under `root` a path names, or nothing when the path leads out of `root`. */
export function fileUnder(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const path = resolve(root, `.${decoded}`);
  return !decoded.includes("\0") && (path === root || path.startsWith(root + sep)) ? path : undefined;
}

const refusal = (status: number, words: string) => new Response(words, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// How many of the pages served last have a token the app still knows, which is more than a window draws at once.
const TOKENS_KEPT = 256;

/**
 * Answers the requests to both schemes. `key` is the app's key to the server
 * once it holds one, and `fetch` reaches the server and, in development, the
 * Vite server at `devServer`. `files` is the folder the built window is in.
 * `trouble` is called when the server refuses the key or can't be reached, so
 * the app looks at its connection again.
 */
export function createHandlers({ port, key, fetch, files, devServer, trouble }: {
  port: number;
  key: () => string | undefined;
  fetch: (url: string, init: RequestInit & { duplex?: "half" }) => Promise<Response>;
  files: string;
  devServer?: string;
  trouble: () => void;
}) {
  const policy = windowPolicy(devServer);
  // The window's open event stream. A request reaches the handler with nothing that says the window gave it up, so the stream's connection to the server is ended here.
  let events: AbortController | undefined;
  // The token made for each page served lately, which the app's script in that page shows to have a link opened.
  const tokens = new Set<string>();

  /** Passes a request on to the server and hands back the server's answer as it is, so an answer that streams keeps streaming. */
  async function api(request: Request, address: string): Promise<Response> {
    if (request.headers.get(FROM_WINDOW) !== "yes") return refusal(403, "Only the Sidebots window may call the server.");
    const held = key();
    if (!held) return refusal(503, "Sidebots isn't ready yet.");
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers: apiHeaders(request.headers, held) };
    if (request.body) {
      init.body = request.body;
      init.duplex = "half";
    }
    if (request.method === "GET" && new URL(address).pathname === "/events") {
      events?.abort();
      events = new AbortController();
      init.signal = events.signal;
    }
    try {
      const answer = await fetch(address, init);
      if (answer.status === 401) trouble();
      return answer;
    } catch {
      trouble();
      return refusal(502, NOT_RUNNING);
    }
  }

  /** One of the window's own files. A path that names no file is the window's page, which reads the path itself. */
  async function file(request: Request, url: URL): Promise<Response> {
    if (devServer) {
      const served = await fetch(`${devServer}${url.pathname}${url.search}`, { headers: passedOn(request.headers) });
      const headers = new Headers(served.headers);
      headers.set("Content-Security-Policy", policy);
      return new Response(served.body, { status: served.status, headers });
    }
    const path = fileUnder(files, url.pathname);
    if (!path) return refusal(404, "No such file.");
    const named = extname(path) !== "";
    const contents = await readFile(named ? path : join(files, "index.html")).catch(() => undefined);
    if (!contents) return refusal(404, "No such file.");
    const type = TYPES[named ? extname(path).toLowerCase() : ".html"] ?? "application/octet-stream";
    return new Response(new Uint8Array(contents), { headers: { "Content-Type": type, "Content-Security-Policy": policy, "X-Content-Type-Options": "nosniff" } });
  }

  return {
    /** Answers a request to `sidebots-desktop://app`. */
    async app(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const address = apiAddress(url, port);
      if (address) return api(request, address);
      if (url.host !== "app" || url.pathname === "/api") return refusal(404, "No such file.");
      if (request.method !== "GET" && request.method !== "HEAD") return refusal(405, "The window's files can only be read.");
      return file(request, url);
    },

    /** Answers a request to `sidebots-page://page` with an agent's page, dressed in the chat's colours. */
    async page(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const address = request.method === "GET" ? pageAddress(url, port) : undefined;
      if (!address) return refusal(404, "Only a page an agent sent is here.");
      const theme = pageTheme(url.searchParams);
      if (!theme) return refusal(400, "A page is asked for with its colours, each #RRGGBB, and whether they are dark or light.");
      const held = key();
      if (!held) return refusal(503, "Sidebots isn't ready yet.");
      const answer = await fetch(address, { headers: { Authorization: `Bearer ${held}` } }).catch(() => undefined);
      if (!answer?.ok) return refusal(answer?.status === 404 ? 404 : 502, "Sidebots couldn't read that page.");
      const token = randomBytes(16).toString("hex");
      tokens.add(token);
      if (tokens.size > TOKENS_KEPT) tokens.delete(tokens.values().next().value!);
      return new Response(dressed(await answer.text(), theme, token), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_POLICY, "X-Content-Type-Options": "nosniff" },
      });
    },

    /**
     * The link a page asks the app to open, from the address its frame was
     * moved to: `sidebots-page://open/<token>?to=<link>`. Nothing when the
     * address isn't one of those, or its token is of no page served lately.
     */
    pageLink(address: string): string | undefined {
      const url = URL.parse(address);
      if (!url || !isAt(OPEN_ORIGIN, address) || !tokens.has(url.pathname.slice(1))) return undefined;
      return url.searchParams.get("to") ?? undefined;
    },

    /** Ends the open event stream's connection to the server, as when the window that opened it loads again or closes. */
    endEvents(): void {
      events?.abort();
      events = undefined;
    },
  };
}
