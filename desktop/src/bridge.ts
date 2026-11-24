// What the window may ask of the main process: the shape of `window.desktop`
// and the names of the channels it travels on. The main process, the preload
// and the window all import this file, so it imports nothing.

/**
 * Where the app stands with the Sidebots server on this computer. `starting`
 * until the server answers, `setup` when nobody is set up on it, `ready` once
 * the app holds a key the server knows, with the computer's name and the
 * person's, and `failed` with words for the person when it can't get there.
 * A connection that failed because the server and this app speak different
 * versions of the contract says which side is `behind`.
 */
export type Connection =
  | { phase: "starting" }
  | { phase: "setup" }
  | { phase: "ready"; machine: string; person: string }
  | { phase: "failed"; message: string; behind?: keyof typeof UPDATE };

/**
 * What to update when the server on this computer and this app speak
 * different versions of the contract, by the side that is behind. The window
 * says so in these words, and they are the `message` of a connection that
 * failed because the main process met the other version.
 */
export const UPDATE = { computer: "Update Sidebots on this computer", app: "Update this app" } as const;

/** What the app says when no server answers on this computer. */
export const NOT_RUNNING = "Sidebots isn't running on this computer.";

/** A phone paired with this computer. `pairedAt` is in milliseconds since 1970. */
export type Phone = { id: string; name: string; pairedAt: number };

/** What pairs one more phone: the link its QR code holds, and when the link runs out, in milliseconds since 1970. */
export type PhonePairing = { link: string; expiresAt: number };

/** A message the system shows the person, and the chat a click on it opens. */
export type Notice = { title: string; body: string; agentId: string; messageId: string };

/** The chat a clicked notification opens, at the message it was about. */
export type OpenChat = { agentId: string; messageId: string };

/** What the app menu asks the window to do. */
export type MenuAction = "new-agent" | "settings" | "toggle-sidebar" | "search";

export type Desktop = {
  /** The system the app runs on, as Node names it: `darwin` for a Mac, `win32` for Windows. */
  platform: string;
  /** The app's version. */
  version: string;

  /** Whether the window fills the screen, when the title bar leaves no room for the window's buttons. */
  fullScreen(): boolean;
  /** Calls `listener` when the window starts or stops filling the screen. Returns a function that stops it. */
  onFullScreen(listener: (fullScreen: boolean) => void): () => void;

  /** Whether the person is at the computer: its screen isn't locked, and they have used it in the last two minutes. */
  present(): boolean;
  /** Calls `listener` when the person leaves the computer or comes back to it. Returns a function that stops it. */
  onPresent(listener: (present: boolean) => void): () => void;

  connection(): Promise<Connection>;
  /** Calls `listener` whenever the connection changes. Returns a function that stops it. */
  onConnection(listener: (connection: Connection) => void): () => void;
  /** Looks at the server again now, and asks the computer to start it when it isn't running. */
  retry(): Promise<void>;
  /** Sends the person to where Sidebots is set up on this computer. */
  openSetup(): Promise<void>;

  phones(): Promise<Phone[]>;
  /** Makes the link that pairs one more phone. It fails, with words for the person, while the computer has no address for phones yet. */
  pairPhone(): Promise<PhonePairing>;
  removePhone(id: string): Promise<void>;

  /**
   * Opens a connection's sign-in page in the system browser and resolves to
   * the address the browser came back on: `redirect`, with the `state` that
   * `url` carries. Null when `url` carries none, the person hasn't come back
   * within ten minutes, or another sign-in has started since.
   */
  signIn(url: string, redirect: string): Promise<string | null>;
  /** Opens a web address in the system browser. */
  openExternal(url: string): Promise<void>;

  /**
   * Opens a file an agent sent in the computer's own app for it, when it is a
   * document to look at, as a picture, a PDF or a page. Any other kind is
   * shown in its folder, for the person to open. `path` is the file's path in
   * the agent's folder, as a message's `attachments` hold it.
   */
  openFile(agentId: string, path: string): Promise<void>;
  /** Saves a file an agent sent where the person chooses. Resolves to whether it was saved. */
  saveFile(agentId: string, path: string): Promise<boolean>;

  /** Shows a notification through the system. A click on it shows the window and tells `onOpenChat`. */
  notify(notice: Notice): void;
  /** Takes away the notifications shown for every agent but those `unread` names, which still have something unread. */
  clearNotices(unread: string[]): void;
  onOpenChat(listener: (chat: OpenChat) => void): () => void;
  /** Sets the number on the app's icon. Zero takes it off. */
  setBadge(count: number): void;

  onMenu(listener: (action: MenuAction) => void): () => void;
};

/** The channels between the window and the main process, each named for what it does. */
export const CHANNELS = {
  readStartup: "desktop:read-startup",
  changeFullScreen: "desktop:change-full-screen",
  changePresent: "desktop:change-present",
  readConnection: "desktop:read-connection",
  changeConnection: "desktop:change-connection",
  retryConnection: "desktop:retry-connection",
  openSetup: "desktop:open-setup",
  listPhones: "desktop:list-phones",
  pairPhone: "desktop:pair-phone",
  removePhone: "desktop:remove-phone",
  signIn: "desktop:sign-in",
  openExternal: "desktop:open-external",
  openFile: "desktop:open-file",
  saveFile: "desktop:save-file",
  showNotice: "desktop:show-notice",
  clearNotices: "desktop:clear-notices",
  openChat: "desktop:open-chat",
  setBadge: "desktop:set-badge",
  runMenu: "desktop:run-menu",
} as const;

/** How tall the bar across the top of each column is, in pixels. On Windows the system's own buttons sit in a strip as tall, so they line up with what is in the bar. */
export const TOP_BAR = 52;

/** What the preload reads before the window's first script runs. */
export type Startup = { version: string; fullScreen: boolean };

declare global {
  interface Window {
    desktop: Desktop;
  }
}
