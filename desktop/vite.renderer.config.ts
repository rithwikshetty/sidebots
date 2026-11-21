// Builds the window, which is everything in src/renderer.

import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where the window's files are served from in development. The main process hands them on at sidebots-desktop://app, so the page is told where to find the server for its live updates.
const DEV_PORT = 5183;

// The window shares the client logic with the phone app, and the server's wire types and avatar sheet layout. The starter avatars are where the mascot comes from.
const CLIENT = resolve(import.meta.dirname, "../client");
const SERVER = resolve(import.meta.dirname, "../server/src");
const AVATARS = resolve(import.meta.dirname, "../avatars");
const RENDERER = resolve(import.meta.dirname, "src/renderer");

export default defineConfig({
  root: RENDERER,
  base: "/",
  build: { outDir: resolve(import.meta.dirname, ".vite/renderer/main_window"), emptyOutDir: true },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@client": CLIENT, "@server": SERVER } },
  server: { port: DEV_PORT, strictPort: true, hmr: { protocol: "ws", host: "localhost", clientPort: DEV_PORT }, fs: { allow: [RENDERER, CLIENT, SERVER, AVATARS] } },
});
