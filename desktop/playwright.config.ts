import { defineConfig } from "@playwright/test";

// The tests in e2e, written on e2e/fixtures.ts. Each has a home and a port of
// its own, so they run side by side. The `harness` project tests the scripted
// server alone. The `app` project opens the packaged app, which
// `E2E=1 pnpm package` builds, and the app's build folder is shared, so take
// the lock first and give it back after:
//
//   until mkdir /tmp/sidebots-desktop-build.lock 2>/dev/null; do sleep 5; done
//   pnpm e2e --project app
//   rmdir /tmp/sidebots-desktop-build.lock
//
// Each project keeps what its failed tests leave in a folder of its own under
// test-results, so a run of one project leaves the others' alone.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  reporter: "list",
  fullyParallel: true,
  workers: 3,
  projects: [
    { name: "harness", testMatch: "harness.spec.ts", outputDir: "test-results/harness" },
    { name: "shell", testMatch: ["startup.spec.ts", "sidebar.spec.ts", "window.spec.ts"], outputDir: "test-results/shell" },
    { name: "app", testMatch: ["smoke.spec.ts", "app.spec.ts", "chat-*.spec.ts", "panel.spec.ts", "settings.spec.ts", "notifications.spec.ts", "security.spec.ts"], outputDir: "test-results/app" },
  ],
});
