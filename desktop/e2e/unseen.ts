// Keeps the app the tests drive and whoever is at the computer out of each
// other's way. It has no icon in the Dock, and its window shows fully
// see-through and without coming to the front, so it draws as it does on
// screen and takes neither the keyboard nor a click, and the computer's own
// pointer can't end what a test drags. This runs in the app's main process
// before the app's own code (src/main/main.ts): the app shows its window as
// soon as its first paint is ready, which is sooner than a test can reach it.

import { app, BrowserWindow } from "electron";

app.setActivationPolicy("accessory");
const { showInactive } = BrowserWindow.prototype;
BrowserWindow.prototype.show = function (this: BrowserWindow) {
  this.setOpacity(0);
  this.setIgnoreMouseEvents(true);
  showInactive.call(this);
};
BrowserWindow.prototype.focus = () => undefined;

// The computer's own pointer still tells a window that ignores it when it
// comes to lie over it and when it leaves, with no button down. To a page
// whose mouse a test holds down, that reads as the button let go, and the page
// lets go of what the test is dragging. A test's own moves carry the button it
// holds, so from a press to its release the page hears of no move, coming or
// going without one.
app.on("web-contents-created", (_created, contents) => {
  let pressed = false;
  contents.on("before-mouse-event", (event, mouse) => {
    if (mouse.type === "mouseDown") pressed = true;
    else if (mouse.type === "mouseUp") pressed = false;
    else if (pressed && (mouse.type === "mouseMove" || mouse.type === "mouseEnter" || mouse.type === "mouseLeave") && (mouse.button as string) === "none") event.preventDefault();
  });
});
