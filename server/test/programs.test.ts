import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { inFolder, installed, later, locate, login, program, shellPath } from "../src/programs.ts";

/** A folder with a program in it that prints `says` when it is run. */
function folderWith(command: string, says: string, mode = 0o755): string {
  const folder = mkdtempSync(join(tmpdir(), "sidebots-programs-"));
  writeFileSync(join(folder, command), `#!/bin/sh\necho "${says}"\n`, { mode });
  chmodSync(join(folder, command), mode);
  return folder;
}

test("a version is later by its numbers, not its letters", () => {
  assert.ok(later("2.1.325", "2.1.99") > 0);
  assert.ok(later("0.170.0", "0.171.0") < 0);
  assert.equal(later("0.170.0", "0.170.0"), 0);
  assert.ok(later("6.2", "6") > 0);
});

test("a program is the first by its name on the PATH that can be run", () => {
  const empty = mkdtempSync(join(tmpdir(), "sidebots-programs-"));
  mkdirSync(join(empty, "codex"));
  const unrunnable = folderWith("codex", "codex-cli 0.170.0", 0o644);
  const first = folderWith("codex", "codex-cli 0.170.0");
  const second = folderWith("codex", "codex-cli 0.171.0");
  // A folder by the name and a file that can't be run are passed over.
  assert.equal(locate("codex", [empty, unrunnable, first, second].join(":")), join(first, "codex"));
  assert.equal(locate("claude", [first, second].join(":")), undefined);
});

test("a provider's program has the version it says, and works when it is no older than its driver does", async () => {
  const current = folderWith("codex", "codex-cli 0.171.2");
  assert.deepEqual(await installed("codex", current), { path: join(current, "codex"), version: "0.171.2", supported: true });
  const old = folderWith("codex", "codex-cli 0.160.0");
  assert.deepEqual(await installed("codex", old), { path: join(old, "codex"), version: "0.160.0", supported: false });
  assert.equal((await installed("claude", folderWith("claude", "2.1.327 (Claude Code)")))?.version, "2.1.327");
  // Not there, or something else by the name.
  assert.equal(await installed("claude", current), undefined);
  assert.equal(await installed("codex", folderWith("codex", "hello")), undefined);
});

test("a turn's program is the one installed, and a missing or old one says what to do on the computer", async () => {
  const current = folderWith("codex", "codex-cli 0.170.0");
  assert.equal(await program("codex", current), join(current, "codex"));
  const words = (run: Promise<string>) => run.then(() => "", (error: Error) => error.message);
  assert.equal(await words(program("claude", current)), "Sidebots can't find Claude Code on your computer. Install it there.");
  assert.equal(await words(program("codex", folderWith("codex", "codex-cli 0.160.0"))), "Codex on your computer is version 0.160.0, and Sidebots needs 0.170.0 or later. Update it there.");
});

test("the PATH is the one the person's shell has once it has read its startup files, whatever they print", async () => {
  // A shell whose startup prints a greeting and puts a folder of the person's on the PATH.
  const folder = mkdtempSync(join(tmpdir(), "sidebots-programs-"));
  const shell = join(folder, "shell");
  writeFileSync(shell, `#!/bin/sh\necho "Welcome back"\nPATH="/people/alex/bin:/usr/bin:/bin"\nexport PATH\n[ "$1" = "-ilc" ] && eval "$2"\n`, { mode: 0o755 });
  assert.equal(await shellPath(shell), "/people/alex/bin:/usr/bin:/bin");
  assert.equal(await shellPath(join(folder, "no-such-shell")), "");
});

test("a program is pointed at a config folder, except the one it uses by itself", () => {
  const env = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/inherited", CODEX_HOME: "/inherited" };
  // Named, Claude Code's own folder would have a login apart from the one the person signed in with.
  assert.deepEqual(inFolder("claude", join(homedir(), ".claude"), env), { PATH: "/usr/bin", CODEX_HOME: "/inherited" });
  assert.deepEqual(inFolder("claude", "/people/robin/claude", env), { PATH: "/usr/bin", CODEX_HOME: "/inherited", CLAUDE_CONFIG_DIR: "/people/robin/claude" });
  assert.deepEqual(inFolder("codex", join(homedir(), ".codex"), env), { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/inherited" });
});

test("a Codex login is signed in when its status ends well, and is an API key when Codex says so", async () => {
  /** A folder with a Codex in it whose `login status` prints `says` as errors, as Codex does, and ends with `status`. */
  const codexThatSays = (says: string, status = 0) => {
    const folder = mkdtempSync(join(tmpdir(), "sidebots-programs-"));
    writeFileSync(join(folder, "codex"), `#!/bin/sh\n[ "$1" = "--version" ] && echo "codex-cli 0.170.0" && exit 0\necho "${says}" >&2\nexit ${status}\n`, { mode: 0o755 });
    return folder;
  };
  const said = (says: string, status?: number) => login("codex", "/people/alex/codex", codexThatSays(says, status));
  assert.deepEqual(await said("Logged in using ChatGPT"), { logged_in: true, email: null, api_key: false });
  assert.deepEqual(await said("API key configured - sk-proj-***abcde"), { logged_in: true, email: null, api_key: true });
  assert.deepEqual(await said("Not logged in", 1), { logged_in: false, email: null, api_key: false });
});
