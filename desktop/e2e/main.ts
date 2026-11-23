// The main process of the app the tests drive, which `E2E=1 pnpm package`
// builds (forge.config.ts): the app's own, started after unseen.ts, so the
// app is out of the way before it makes its window.

import "./unseen.ts";
import "../src/main/main.ts";
