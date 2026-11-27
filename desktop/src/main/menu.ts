// The app's menu. What a menu item does to the window's own screens, the
// window carries out: the menu only names it.

import { Menu, type MenuItemConstructorOptions, app, shell } from "electron";
import type { MenuAction } from "../bridge.ts";

/** Sets the app's menu. `run` hands the window what the person chose, and `development` adds what only someone working on the app needs. */
export function setMenu(run: (action: MenuAction) => void, development: boolean): void {
  const settings: MenuItemConstructorOptions = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => run("settings") };
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "New Agent", accelerator: "CmdOrCtrl+N", click: () => run("new-agent") },
        { type: "separator" },
        // A system with no app menu keeps Settings and Quit here.
        ...(process.platform === "darwin" ? [] : [settings, { type: "separator" } as const]),
        { role: "close", label: "Close Window" },
        ...(process.platform === "darwin" ? [] : [{ role: "quit" } as const]),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", click: () => run("toggle-sidebar") },
        { label: "Search", accelerator: "CmdOrCtrl+K", click: () => run("search") },
        { label: "Write a Message", accelerator: "CmdOrCtrl+/", click: () => run("write") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(development ? [{ type: "separator" } as const, { role: "reload" } as const, { role: "toggleDevTools" } as const] : []),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "sidebots.app", click: () => void shell.openExternal("https://sidebots.app") },
        { label: "Privacy", click: () => void shell.openExternal("https://sidebots.app/privacy") },
      ],
    },
  ];
  if (process.platform === "darwin") {
    template.unshift({
      label: app.name,
      submenu: [{ role: "about" }, { type: "separator" }, settings, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
