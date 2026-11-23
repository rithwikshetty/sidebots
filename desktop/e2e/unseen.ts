// Keeps the app the tests drive out of the way of whoever is at the computer.
// It has no icon in the Dock, and its window shows fully see-through and
// without coming to the front, so it draws as it does on screen and takes
// neither the keyboard nor a click. This runs in the app's main process
// before the app's own code (main.ts): the app shows its window as soon as
// its first paint is ready, which is sooner than a test can reach it.

import { app, BrowserWindow } from "electron";

app.setActivationPolicy("accessory");
const { showInactive } = BrowserWindow.prototype;
BrowserWindow.prototype.show = function (this: BrowserWindow) {
  this.setOpacity(0);
  this.setIgnoreMouseEvents(true);
  showInactive.call(this);
};
BrowserWindow.prototype.focus = () => undefined;
