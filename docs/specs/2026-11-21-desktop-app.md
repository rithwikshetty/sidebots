# Sidebots on the desktop

Sidebots opens as a window on the computer that runs it. The window lists the person's agents and their chats, as the phone app does, so a person can use Sidebots with no phone at all. The phone app is a second way in: it pairs with the computer from the desktop window or from the menu bar.

## Decisions

- **Three programs.** The server in `server/` runs the agents. The phone app in `mobile/` and the desktop app in `desktop/` are its two clients. They draw their own screens and share everything else: the wire types in `server/src/contract.ts` and the client logic in `client/`.
- **The desktop app is Electron with a React window.** Electron runs on macOS and Windows, so the same app can ship on Windows. Its window is drawn with React, Tailwind and Base UI.
- **On a Mac, the menu bar app still holds the server.** `mac/` stays the outer `Sidebots.app`: it runs the server, keeps it running, signs the person in to their providers, updates itself with Sparkle, and shows the menu bar panel. The desktop app sits inside it at `Contents/Helpers/Sidebots.app`, and the menu bar app opens it. Quitting the window leaves the server and the menu bar icon running, so agents keep working and phones keep reaching them. Quitting from the menu bar quits both.
- **The desktop app pairs itself.** A window on the same computer is a device like any phone. The desktop app's main process makes a pairing code with the server's own `pair` command and uses it over `127.0.0.1`. It keeps the key in a file only the person's account can read, in the app's own data folder, and never hands it to the window. A key file it can't read holds no key, so the app pairs again. Any program of that account could make itself a key the same way, so the keychain would add nothing. With `SIDEBOTS_HOME` set, the desktop app keeps its data in `desktop` inside that folder, so a copy tried beside the real one shares nothing with it.
- **The window reaches the server through the main process.** The window loads from `sidebots-desktop://app/`. Requests under `/api/` go to the main process, which adds the key and passes them to the server. The window's code, images, uploads and the event stream all come from one origin, and nothing in the window holds a secret.
- **A page an agent sends is untrusted.** It is drawn in a sandboxed frame from a scheme of its own, `sidebots-page://`, with no access to the window, the API or the network beyond images.
- **Nothing in the design is only for the Mac.** Everything the desktop app needs of the computer goes through one module in its main process, `host`. On a Mac that module opens the menu bar app, which runs the server and sets the person up. A Windows build gives it another body that runs the server itself.

## The shared client: `client/`

`client/` holds what both apps do the same way: the store of agents, messages, avatars, usage and connections; the event stream and its retries; the changes to agents that wait for the server; paging through a chat; the errors a call can end in; and the small pure helpers (times, the working lines, usage sums, file kinds, names and limits, the style a page starts with, the chat colours, a message as one line, a found message as one line, where an exchange between agents stands, and what to ask before something that can't be undone). It imports the contract and nothing else, as the contract imports nothing, so each app builds it with its own tools.

Each app gives the store the few things that differ: how to call the server, how to open the event stream, where to save the copy it keeps, when the app comes back to the front, how a file goes into a form, and how a sign-in opens. `mobile/src/lib/state.ts` and `api.ts` keep the phone's side of that: pairing, the Keychain, the demo computer, Expo's fetch and storage. The desktop's side is in `desktop/src/renderer/lib`.

## The desktop app: `desktop/`

```
desktop/
  forge.config.ts            Electron Forge: packages the app unsigned, sets the fuses
  src/main/                  the main process
    main.ts                  starts the app: one instance, the window, the menu
    window.ts                the window, its saved size and place, its colours
    protocol.ts              sidebots-desktop:// (the window's files, /api) and sidebots-page:// (agents' pages)
    host.ts                  the computer: where Node and the server are, their commands, starting them
    connection.ts            where the app stands with the server, looked at again every few seconds
    pairing.ts               the desktop's own key
    bridge.ts                what the window may ask of the main process, over IPC
    links.ts                 which addresses go to the system browser, and which files to the system's apps
    menu.ts                  the app's menu
  src/preload.ts             exposes `window.desktop`
  src/bridge.ts              the shape of `window.desktop`, shared by main, preload and window
  src/renderer/              the window: React
  test/                      unit tests of the main process
  e2e/                       Playwright tests that drive the built app against a server with scripted agents
```

**The window.** 1100 by 780 to start, no smaller than 760 by 520, and it opens where it was last. On macOS the title bar is hidden and inset, with the traffic lights at 16, 19 in a bar 52 points tall that drags the window. On Windows the title bar is hidden under an overlay as tall as that bar, 52 points, that keeps the system's buttons. It is shown once its first paint is ready, on a background that matches the system's light or dark, so it never flashes white. Closing the window on macOS hides it, so replies still notify. The app has one instance: opening it again brings the window forward.

**Starting.** The main process asks the host how the server stands (`status --json`). No server running: it asks the host to start it and shows "Starting Sidebots…". On a Mac the host opens the menu bar app, with the `PORT`, `SIDEBOTS_HOME` and `SIDEBOTS_RELAY` the desktop app was given, unless that app already runs: it starts its own server again, and opening it would bring the window forward. A copy that sits inside no menu bar app can't start the server, and says Sidebots isn't running until one answers. Nobody set up: it shows a screen that sends the person to setup. Otherwise it makes sure it holds a key the server knows, as the first person set up there, pairing again when it doesn't, and the window loads the agents. A server on another version of the contract shows which side to update, as the phone does, in the same words whether the window or the main process meets it first. A look that leaves the app short of ready is followed a moment later by another, then by looks less and less often, up to two seconds apart. A ready app asks the server's `GET /status` every five seconds whether it is up and still knows the app's key.

**The API proxy.** `sidebots-desktop://app/api/<path>` goes to `http://127.0.0.1:<port>/<path>` with the key and the contract header. Bodies and answers stream through untouched, so uploads and the event stream work as they do for a phone. Only the window's own top document may call it: a frame at another origin, as an agent's page, is refused. An answer that sends its request on into either of the app's schemes from another scheme, as a picture's server can, is refused before the request is made, since it would arrive as one of the window's own. Only the scheme is read, so no spelling of the address gets past. The main process ends an event stream's connection to the server when the window that opened it reloads, closes or opens another.

**Pages.** `sidebots-page://page/<agent>/<attachment>` answers with the agent's `.html` file, with the theme's colours set as the CSS variables the phone sets (`--bg --ink --ink2 --line --field --tint`), and under a policy that lets the page run its own scripts and styles and load images and fonts, and nothing else. The frame is `sandbox="allow-scripts"`, so a page opens no window, and the main process stops every move a page's frame makes by itself. A page takes the keyboard only when the person clicks in it: the frame denies it `focus-without-user-activation`, which the window turns on as Chromium's `BlockingFocusWithoutUserActivation`. A link in a page opens in the system browser when it is `http` or `https` and the person clicked it: the app's own script at the start of the page moves the frame to `sidebots-page://open/<token>?to=<link>` on a click the browser says is the person's, and the main process, which made the token for that page and never shows it to the page's scripts, stops the move and opens the link. A page tells the window its height, so a short page takes only the room it needs. A page in a chat is drawn once the server says it has the file, and holds its place until then, as while the server is out of reach.

**Files.** A file an agent sent is saved where the person chooses, or opened. A document to look at, such as a picture, a PDF or a page, opens in the computer's own app for it. Any other kind could run something, so it is shown in its folder for the person to open. A person adds files to a message with a button, by dragging them onto the chat, or by pasting.

**Connections.** A sign-in to Gmail, Google Calendar or Notion opens in the system browser. The address it ends on names a scheme the desktop app is registered for, so the browser hands it back, and the main process gives it to the server.

**Phones.** Settings lists the paired phones, removes one, and shows the QR code that pairs another, made by the server's `pair` command.

**Notifications.** A reply, an ask or a failure notifies through the system when the person isn't looking at that chat, unless the agent is muted. It follows the rule the server uses for phones: it notifies two seconds after the message comes, and only when the message is still unread, so one the person reads on their phone as it comes stays quiet here. The person is looking at a chat when it is open in the window in front with nothing over it and they are at the computer: its screen isn't locked, and they have used it in the last two minutes. A chat left open in front of nobody isn't looked at, so what comes into it stays unread and notifies, here and on the phone. A notification goes once its chat has nothing unread, as when the person reads it on their phone. A click opens the chat at the message, or at the nearest one drawn when the message draws nothing, as a turn that ended without a reply. The Dock icon counts what is unread in the chats the person isn't looking at.

**What the window shows.** A sidebar with the agents, search and a way to add one; the chat with its composer, whose button with the provider's logo, whose tooltip names the model and the effort, opens a panel that changes what the agent answers with: a rail of the providers by logo, the models of the one picked there, the efforts beside them, and Standard and Fast across the foot; and a panel at the right that opens beside the chat for an agent's page, a picture, what two agents said to each other, and an agent's settings, jobs, instructions and memory, which it fetches again as the agent's turns start and end. Usage, Connections, Phones and About are in Settings. Every action the phone has is here, by pointer and by keyboard: Enter sends, Shift+Enter starts a new line, and the menu bar's items have their shortcuts.

## Server

A device has a `kind`: `phone` or `desktop`. A desktop names its kind as it pairs. `devices` says each device's kind, the menu bar panel lists only phones under "Phones", and the count of paired phones the relay hears leaves desktops out.

## Mac app

- The panel's first row opens the window: "Open Sidebots".
- Opening Sidebots while it runs opens the window. Opening it for the first time ends setup in the window, not in the QR code. Sidebots opened by the system at login shows only its menu bar icon.
- The menu bar app passes `PORT`, `SIDEBOTS_HOME` and `SIDEBOTS_RELAY` on to the window's app, as it does to the server.
- Quitting from the panel quits the window's app too, one that was still opening included, and waits until it has gone. An update quits it before it installs, and opens it again after when it was open.
- `mac/build.sh` packages the desktop app, puts it in `Contents/Helpers`, and signs it from the inside out with the rest.

## Tests

- `client/` has unit tests for the store: events, paging, pending changes, asks, the retry of a dropped stream.
- The desktop's main process has unit tests for the proxy, pairing, the connection, the host, what the window may ask and what a page may do.
- `desktop/e2e` drives the built app with Playwright against a real server whose providers are scripted, through every screen and state: empty, working, asks, failures, files, pages, search, settings, light and dark, narrow and wide.

## Out of scope

- A Windows or Linux build of the desktop app
- A desktop app that runs the server by itself, without the menu bar app
- Setup, provider sign-in and updates inside the window: they stay in the menu bar app
- Dictation, and a queue for messages typed while the server is out of reach
