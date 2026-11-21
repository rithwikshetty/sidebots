import { expect, test } from "vitest";
import { userInfo } from "node:os";
import { createHost, locate } from "../src/main/host.ts";

const inside = "/Applications/Sidebots.app/Contents/Helpers/Sidebots.app/Contents/MacOS/Sidebots";
const alone = "/repo/desktop/out/Sidebots-darwin-arm64/Sidebots.app/Contents/MacOS/Sidebots";

test("SIDEBOTS_NODE and SIDEBOTS_SERVER name Node and the server's folder wherever the app is", () => {
  const env = { SIDEBOTS_NODE: "/opt/node", SIDEBOTS_SERVER: "/srv/sidebots" };
  expect(locate(env, alone, "/repo/desktop")).toEqual({ node: "/opt/node", server: "/srv/sidebots" });
  expect(locate(env, inside, "/anywhere")).toEqual({ node: "/opt/node", server: "/srv/sidebots", outer: "/Applications/Sidebots.app" });
});

test("an app inside the menu bar app uses the Node and the server that app carries", () => {
  expect(locate({}, inside, "/Applications/Sidebots.app/Contents/Helpers/Sidebots.app/Contents/Resources/app.asar")).toEqual({
    node: "/Applications/Sidebots.app/Contents/Resources/bin/node",
    server: "/Applications/Sidebots.app/Contents/Resources/server",
    outer: "/Applications/Sidebots.app",
  });
  // One of the two named, and the other is still the outer app's.
  expect(locate({ SIDEBOTS_NODE: "/opt/node" }, inside, "/anywhere").server).toBe("/Applications/Sidebots.app/Contents/Resources/server");
});

test("any other copy is run from the repository: the node on the PATH, and the server folder beside the app's own", () => {
  expect(locate({}, "/repo/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "/repo/desktop")).toEqual({ node: "node", server: "/repo/server" });
  // A folder that only looks like the menu bar app's is not one.
  expect(locate({}, "/tmp/Helpers/Sidebots.app/Contents/MacOS/Sidebots", "/repo/desktop").outer).toBeUndefined();
  expect(locate({}, "/tmp/Other.app/Contents/Frameworks/Sidebots.app/Contents/MacOS/Sidebots", "/repo/desktop").outer).toBeUndefined();
});

/** A host whose programs are the test's: `runs` says whether the menu bar app runs, and `ran` is every program the host ran, with what it was given. */
function hostWith(env: NodeJS.ProcessEnv, program: string, runs = false) {
  const ran: { program: string; args: string[] }[] = [];
  const host = createHost(env, program, "/anywhere", async (program, args) => {
    ran.push({ program, args });
    if (program === "/usr/bin/pgrep" && !runs) throw new Error("Command failed: /usr/bin/pgrep");
    return "";
  });
  return { host, ran };
}

test("the server is started by opening the menu bar app, and only when that app doesn't run", async () => {
  const stopped = hostWith({}, inside);
  expect(await stopped.host.startServer()).toBe(true);
  expect(stopped.ran.map((each) => each.program)).toEqual(["/usr/bin/pgrep", "/usr/bin/open"]);
  expect(stopped.ran[1].args).toEqual(["/Applications/Sidebots.app"]);

  // A menu bar app that runs starts its server again by itself. Opening it would bring the window forward.
  const running = hostWith({}, inside, true);
  expect(await running.host.startServer()).toBe(true);
  expect(running.ran.map((each) => each.program)).toEqual(["/usr/bin/pgrep"]);
});

test("the menu bar app runs when a program of this account's is its own executable, which this app's own is not", async () => {
  const { host, ran } = hostWith({}, "/Users/me/My Apps (2)/Sidebots.app/Contents/Helpers/Sidebots.app/Contents/MacOS/Sidebots");
  await host.startServer();
  const [account, uid, whole, pattern] = ran[0].args;
  expect([account, uid, whole]).toEqual(["-U", String(userInfo().uid), "-f"]);
  const matches = (command: string) => new RegExp(pattern).test(command);
  expect(matches("/Users/me/My Apps (2)/Sidebots.app/Contents/MacOS/Sidebots")).toBe(true);
  expect(matches("/Users/me/My Apps (2)/Sidebots.app/Contents/MacOS/Sidebots -psn_0_12345")).toBe(true);
  // This app and its helpers, the server the menu bar app runs, another copy, and a program only told the path.
  expect(matches("/Users/me/My Apps (2)/Sidebots.app/Contents/Helpers/Sidebots.app/Contents/MacOS/Sidebots")).toBe(false);
  expect(matches("/Users/me/My Apps (2)/Sidebots.app/Contents/Helpers/Sidebots.app/Contents/Frameworks/Sidebots Helper.app/Contents/MacOS/Sidebots Helper --type=gpu-process")).toBe(false);
  expect(matches("/Users/me/My Apps (2)/Sidebots.app/Contents/Resources/bin/node src/main.ts")).toBe(false);
  expect(matches("/Users/me/My Apps (2)/Sidebots.app/Contents/MacOS/Sidebots2")).toBe(false);
  expect(matches("/Users/me/My Apps (2)/SidebotsXapp/Contents/MacOS/Sidebots")).toBe(false);
  expect(matches("/Users/me/My Apps 2/Sidebots.app/Contents/MacOS/Sidebots")).toBe(false);
  expect(matches("/Applications/Sidebots.app/Contents/MacOS/Sidebots")).toBe(false);
  expect(matches("/usr/bin/open /Users/me/My Apps (2)/Sidebots.app/Contents/MacOS/Sidebots")).toBe(false);
});

test("sending the person to setup opens the menu bar app whether or not it runs", async () => {
  const { host, ran } = hostWith({}, inside, true);
  expect(await host.openSetup()).toBe(true);
  expect(ran).toEqual([{ program: "/usr/bin/open", args: ["/Applications/Sidebots.app"] }]);
});

test("the menu bar app is opened with the port, the data folder and the relay this app was given", async () => {
  const given = hostWith({ PORT: "4391", SIDEBOTS_HOME: "/tmp/a home", SIDEBOTS_RELAY: "off", SIDEBOTS_NODE: "/opt/node", HOME: "/Users/me" }, inside);
  await given.host.startServer();
  await given.host.openSetup();
  const args = ["--env", "PORT=4391", "--env", "SIDEBOTS_HOME=/tmp/a home", "--env", "SIDEBOTS_RELAY=off", "/Applications/Sidebots.app"];
  expect(given.ran.filter((each) => each.program === "/usr/bin/open").map((each) => each.args)).toEqual([args, args]);

  // Only what it was given: the menu bar app uses its own for the rest.
  const some = hostWith({ SIDEBOTS_HOME: "/tmp/home" }, inside);
  await some.host.startServer();
  expect(some.ran[1].args).toEqual(["--env", "SIDEBOTS_HOME=/tmp/home", "/Applications/Sidebots.app"]);
});

test("a copy inside no menu bar app can neither start the server nor send the person to setup", async () => {
  const { host, ran } = hostWith({ PORT: "4391" }, alone);
  expect(await host.startServer()).toBe(false);
  expect(await host.openSetup()).toBe(false);
  expect(ran).toEqual([]);
});
