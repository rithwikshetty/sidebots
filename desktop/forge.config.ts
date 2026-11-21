// How Electron Forge builds and packages the desktop app. The packaged app is
// unsigned: on a Mac, mac/build.sh puts it inside the menu bar app and signs
// the two together.

import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

// The client id a person's sign-in to a Google app names, as in server/src/main.ts. Google sends the person back to it turned about.
const GOOGLE_CLIENT = "161867342001-s22m1k5cbkf1vg7s9qhsb66cqhs12ehh.apps.googleusercontent.com";

const config: ForgeConfig = {
  packagerConfig: {
    name: "Sidebots",
    appBundleId: "app.sidebots.desktop",
    // mac/build.sh names the version of the Mac app this one ships inside, which the app then reports as its own. Outside that build it is package.json's.
    appVersion: process.env.SIDEBOTS_VERSION,
    buildVersion: process.env.SIDEBOTS_BUILD,
    icon: "../mac/AppIcon.icns",
    appCategoryType: "public.app-category.productivity",
    asar: true,
    extendInfo: { LSMinimumSystemVersion: "26.0" },
    // The addresses a sign-in to a connection ends on, which the browser hands back to the app.
    protocols: [{ name: "Sidebots sign-in", schemes: ["app.sidebots", GOOGLE_CLIENT.split(".").reverse().join(".")] }],
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/main.ts", config: "vite.node.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.node.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
      // In development, a change to the main process starts the app again.
      hotRestart: true,
    }),
    // What the packaged program refuses to do, whatever it is started with. The plugin signs an unsigned arm64 Mac build again for this Mac only, since changing these breaks the signature Electron came with.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // Playwright drives the app through Node's inspector, so a build made with E2E=1 for the tests in e2e keeps it.
      [FuseV1Options.EnableNodeCliInspectArguments]: process.env.E2E === "1",
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
