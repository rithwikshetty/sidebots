// Runs in the window before its own scripts, closed off from them, and gives
// them `window.desktop`: the few things the window may ask of the main process.

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type Connection, type Desktop, type MenuAction, type OpenChat, type Startup } from "./bridge.ts";

const startup = ipcRenderer.sendSync(CHANNELS.readStartup) as Startup;
let fullScreen = startup.fullScreen;
ipcRenderer.on(CHANNELS.changeFullScreen, (_event, now: boolean) => {
  fullScreen = now;
});
// The person is at the computer until the main process finds they have left it.
let present = true;
ipcRenderer.on(CHANNELS.changePresent, (_event, now: boolean) => {
  present = now;
});

/** Asks the main process for something. A refusal arrives as the main process worded it, without Electron's own words around it. */
async function ask<T>(channel: string, ...values: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...values)) as T;
  } catch (failure) {
    throw new Error((failure as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
  }
}

/** Calls `listener` with what the main process sends on a channel. Returns a function that stops it. */
function hear<T>(channel: string, listener: (value: T) => void): () => void {
  const heard = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, heard);
  return () => void ipcRenderer.removeListener(channel, heard);
}

const desktop: Desktop = {
  platform: process.platform,
  version: startup.version,
  welcome: startup.welcome,
  fullScreen: () => fullScreen,
  onFullScreen: (listener) => hear<boolean>(CHANNELS.changeFullScreen, listener),
  present: () => present,
  onPresent: (listener) => hear<boolean>(CHANNELS.changePresent, listener),
  connection: () => ask<Connection>(CHANNELS.readConnection),
  onConnection: (listener) => hear<Connection>(CHANNELS.changeConnection, listener),
  retry: () => ask(CHANNELS.retryConnection),
  openSetup: () => ask(CHANNELS.openSetup),
  phones: () => ask(CHANNELS.listPhones),
  pairPhone: () => ask(CHANNELS.pairPhone),
  removePhone: (id) => ask(CHANNELS.removePhone, id),
  signIn: (url, redirect) => ask(CHANNELS.signIn, url, redirect),
  openExternal: (url) => ask(CHANNELS.openExternal, url),
  openFile: (agentId, path) => ask(CHANNELS.openFile, agentId, path),
  saveFile: (agentId, path) => ask(CHANNELS.saveFile, agentId, path),
  notify: (notice) => ipcRenderer.send(CHANNELS.showNotice, notice),
  clearNotices: (unread) => ipcRenderer.send(CHANNELS.clearNotices, unread),
  onOpenChat: (listener) => hear<OpenChat>(CHANNELS.openChat, listener),
  setBadge: (count) => ipcRenderer.send(CHANNELS.setBadge, count),
  onMenu: (listener) => hear<MenuAction>(CHANNELS.runMenu, listener),
};

contextBridge.exposeInMainWorld("desktop", desktop);
