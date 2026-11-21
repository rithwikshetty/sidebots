// Starts the desktop app: one copy of it, with its one window and its menu.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, net, protocol, session } from "electron";
import { CHANNELS } from "../bridge.ts";
import { answerWindow, signInReturned, tell } from "./bridge.ts";
import { watchConnection } from "./connection.ts";
import { createHost } from "./host.ts";
import { isAt } from "./links.ts";
import { setMenu } from "./menu.ts";
import { createPairing } from "./pairing.ts";
import { APP_ORIGIN, APP_SCHEME, PAGE_SCHEME, SCHEMES, createHandlers, madeByWindow, sendsIntoWindow, tagged } from "./protocol.ts";
import { createWindow, refusePermissions, show } from "./window.ts";

// With `SIDEBOTS_HOME` set the app keeps its data inside that folder, so a copy tried beside the real one shares nothing with it.
if (process.env.SIDEBOTS_HOME) app.setPath("userData", join(process.env.SIDEBOTS_HOME, "desktop"));
protocol.registerSchemesAsPrivileged(SCHEMES);

// Where Vite serves the window while the app is being worked on. A packaged app has none, and reads the window's files from inside itself.
const devServer: string | undefined = MAIN_WINDOW_VITE_DEV_SERVER_URL;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
else void start();

async function start(): Promise<void> {
  // A sign-in in the browser ends on an address the system hands back to the app.
  app.on("open-url", (event, address) => {
    event.preventDefault();
    signInReturned(address);
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  await app.whenReady();

  const userData = app.getPath("userData");
  mkdirSync(userData, { recursive: true });
  const host = createHost(process.env, app.getPath("exe"), app.getAppPath());
  const fetch = (url: string, init: RequestInit) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });
  const pairing = createPairing({ file: join(userData, "pairing.json"), port: host.port, name: host.name, command: host.command, fetch });

  const window = createWindow({ preload: join(app.getAppPath(), ".vite", "build", "preload.cjs"), userData, quitting: () => quitting, pageLink: (address) => handlers.pageLink(address) });
  const watch = watchConnection(host, pairing, (connection) => tell(window, CHANNELS.changeConnection, connection));
  answerWindow({ window, host, watch, key: pairing.key, fetch, userData });
  refusePermissions();
  setMenu((action) => {
    show(window);
    tell(window, CHANNELS.runMenu, action);
  }, devServer !== undefined);

  const handlers = createHandlers({ port: host.port, key: pairing.key, fetch, files: join(app.getAppPath(), ".vite", "renderer", MAIN_WINDOW_VITE_NAME), devServer, trouble: () => void watch.look() });
  // Each request to the window's origin is marked with whether the window's own document made it, which is all that may call the server.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, send) => {
    if (!isAt(APP_ORIGIN, details.url)) return send({});
    const fromWindow = !window.isDestroyed() && madeByWindow(details, window.webContents.mainFrame);
    send({ requestHeaders: tagged(details.requestHeaders, fromWindow) });
  });
  // An answer that sends its request on into one of the app's schemes from another, as a picture's server can, is refused: the request would reach the window's origin as one of the window's own.
  session.defaultSession.webRequest.onHeadersReceived((details, answer) => answer({ cancel: sendsIntoWindow(details.url, details.responseHeaders) }));
  protocol.handle(APP_SCHEME, handlers.app);
  protocol.handle(PAGE_SCHEME, handlers.page);
  // An event stream the window gave up, by loading again or closing, has its connection to the server ended.
  window.webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isSameDocument) handlers.endEvents();
  });
  window.webContents.on("render-process-gone", handlers.endEvents);
  window.webContents.on("destroyed", handlers.endEvents);

  // Opening the app again, or clicking it in the Dock, brings its window forward. A system that hands an address back by opening the app again passes it here.
  app.on("second-instance", (_event, args) => {
    args.some(signInReturned);
    show(window);
  });
  app.on("activate", () => show(window));
  app.on("window-all-closed", () => app.quit());

  await window.loadURL(`${APP_ORIGIN}/`);
}
