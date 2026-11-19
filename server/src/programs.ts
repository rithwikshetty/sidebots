// The providers' programs on this computer. Sidebots carries none of its own:
// it runs the Claude Code and the Codex the person installed, found the way
// their terminal finds them. It is the only module that looks for them.

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PROVIDERS, type Provider } from "./contract.ts";

/**
 * What Sidebots knows of each provider's program: the command a terminal runs
 * it by, the oldest version its driver works with, the installer its maker
 * publishes, the variable that names its config folder and the folder it uses
 * in the person's home without one, and its commands to sign in through the
 * browser and to say whether it is signed in.
 */
export const PROGRAMS: Record<Provider, { command: string; oldest: string; installer: string; configVariable: string; configDir: string; signIn: string[]; signedIn: string[] }> = {
  claude: {
    command: "claude",
    oldest: "2.1.325",
    installer: "curl -fsSL https://claude.ai/install.sh | bash",
    configVariable: "CLAUDE_CONFIG_DIR",
    configDir: ".claude",
    signIn: ["auth", "login"],
    signedIn: ["auth", "status", "--json"],
  },
  codex: {
    command: "codex",
    oldest: "0.170.0",
    // Its installer asks whether to start Codex once it is in, unless told not to ask.
    installer: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
    configVariable: "CODEX_HOME",
    configDir: ".codex",
    signIn: ["login"],
    signedIn: ["login", "status"],
  },
};

/** A provider's program as it is on this computer: where, which version, and whether its driver works with that version. */
type Installed = { path: string; version: string; supported: boolean };

const run = promisify(execFile);
const MARK = "__sidebots__";
// Where the makers' installers put a program, and where Homebrew does, for a person whose shell has none of them on its PATH.
const USUAL = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
// How long the PATH of the person's shell is taken as read, before a program that isn't found has it read again.
const PATH_FRESH_MS = 30_000;

/** Whether one version is later than another, by their numbers: 2.1.325 is later than 2.1.99. A positive number when it is, and zero when they are the same. */
export function later(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => version.split(".").map(Number));
  return left.map((part, at) => part - (right[at] ?? 0)).find((gap) => gap !== 0) ?? left.length - right.length;
}

/**
 * The PATH of the person's shell, as a terminal they open has it. An
 * interactive login shell reads the startup files that put their tools on
 * it. Those files can print things of their own, so the PATH is read from
 * between two marks. Nothing when the shell can't be asked.
 */
export function shellPath(shell = userInfo().shell || "/bin/zsh"): Promise<string> {
  return new Promise((resolve) => {
    // Apart from this process's terminal, where an interactive shell would stop to take it over.
    const child = spawn(shell, ["-ilc", `echo ${MARK}; /usr/bin/printenv PATH; echo ${MARK}`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let printed = "";
    const late = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", (chunk) => (printed += chunk));
    child.on("error", () => resolve(""));
    child.on("close", () => {
      clearTimeout(late);
      resolve(printed.split(MARK)[1]?.trim() ?? "");
    });
  });
}

let read: { path: Promise<string>; at: number } | undefined;
/**
 * The PATH the providers' programs are looked for on and run with: the
 * person's shell's, then this process's, then the folders programs are
 * usually installed in. `again` reads the shell's PATH anew once the last
 * reading is old, for a program installed since.
 */
function searchPath(again = false): Promise<string> {
  if (!read || (again && Date.now() - read.at > PATH_FRESH_MS)) {
    read = { at: Date.now(), path: shellPath().then((shell) => [...new Set([...shell.split(delimiter), ...(process.env.PATH ?? "").split(delimiter), ...USUAL])].filter(Boolean).join(delimiter)) };
  }
  return read.path;
}

/** What a provider's program runs with: this process's environment, with the PATH its program was found on, so a launcher finds what it launches. */
export async function environment(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await searchPath() };
}

/** The first program by a command's name in the folders of a PATH. */
export function locate(command: string, path: string): string | undefined {
  return path
    .split(delimiter)
    .map((folder) => join(folder, command))
    .find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

// The version each program said it was, kept until the file changes.
const versions = new Map<string, { file: string; version: string | undefined }>();
/** The version a program says it is, when asked with `--version`. */
async function versionOf(program: string, path: string): Promise<string | undefined> {
  const { size, mtimeMs, ino } = statSync(program);
  const file = `${size}:${mtimeMs}:${ino}`;
  const known = versions.get(program);
  if (known?.file === file) return known.version;
  const version = await run(program, ["--version"], { env: { ...process.env, PATH: path }, timeout: 10_000 }).then(
    ({ stdout }) => /\d+\.\d+\.\d+/.exec(stdout)?.[0],
    () => undefined,
  );
  versions.set(program, { file, version });
  return version;
}

/** A provider's program on this computer, on `path` when one is given, or nothing when it isn't installed. */
export async function installed(provider: Provider, path?: string): Promise<Installed | undefined> {
  const { command, oldest } = PROGRAMS[provider];
  const folders = path ?? (await searchPath());
  const program = locate(command, folders) ?? (path === undefined ? locate(command, await searchPath(true)) : undefined);
  const version = program && (await versionOf(program, folders));
  return program && version ? { path: program, version, supported: later(version, oldest) >= 0 } : undefined;
}

/**
 * The provider's program to run a turn on. A turn fails without one, or with
 * one older than the driver works with, in words for the person on their
 * phone.
 */
export async function program(provider: Provider, path?: string): Promise<string> {
  const { name } = PROVIDERS[provider];
  const found = await installed(provider, path);
  if (!found) throw new Error(`Sidebots can't find ${name} on your computer. Install it there.`);
  if (!found.supported) throw new Error(`${name} on your computer is version ${found.version}, and Sidebots needs ${PROGRAMS[provider].oldest} or later. Update it there.`);
  return found.path;
}

/** The config folder a provider's program uses on this computer, for a person who names no other. */
export function configDir(provider: Provider): string {
  const { configVariable, configDir } = PROGRAMS[provider];
  return process.env[configVariable] ?? join(homedir(), configDir);
}

/**
 * An environment that has a provider's program use a config folder. The
 * folder the program uses by itself is left unnamed: Claude Code keeps the
 * login of a folder it is pointed at apart from the one it finds there by
 * itself, so naming it would hide a login the person already has.
 */
export function inFolder(provider: Provider, folder: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { configVariable, configDir } = PROGRAMS[provider];
  const { [configVariable]: _, ...rest } = env;
  return resolve(folder) === join(homedir(), configDir) ? rest : { ...rest, [configVariable]: folder };
}

/** Runs the provider's own sign-in in a config folder, with this process's terminal, which opens its page in the browser. Answers how it ended: 0 once the person has signed in. `stop` ends it early. */
export async function signIn(provider: Provider, folder: string, stop?: AbortSignal): Promise<number> {
  const [signer, env] = [await program(provider), inFolder(provider, folder, await environment())];
  // Codex signs in only to a config folder that is already there.
  mkdirSync(folder, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(signer, PROGRAMS[provider].signIn, { env, stdio: "inherit", signal: stop });
    child.on("error", () => resolve(1));
    child.on("close", (status) => resolve(status ?? 1));
  });
}

/**
 * The login in a provider's config folder, as its program itself reports it:
 * whether it is signed in, as whom when the program says, and whether the
 * login is an API key the person saved there, which is billed for what each
 * turn uses and has no plan. Claude Code prints whether and as whom. Codex
 * says whether it is signed in by how its command ends, and what with in the
 * words it prints as errors. `path` is where the program is looked for, when
 * one is given.
 */
export async function login(provider: Provider, folder: string, path?: string): Promise<{ logged_in: boolean; email: string | null; api_key: boolean }> {
  const env = inFolder(provider, folder, await environment());
  const said = await run(await program(provider, path), PROGRAMS[provider].signedIn, { env, timeout: 30_000 }).catch(() => undefined);
  if (provider === "codex" || said === undefined) return { logged_in: said !== undefined, email: null, api_key: /^API key configured/m.test(said?.stderr ?? "") };
  const { loggedIn, email } = JSON.parse(said.stdout) as { loggedIn: boolean; email?: string };
  return { logged_in: loggedIn, email: email ?? null, api_key: false };
}

/** Runs the installer the provider's maker publishes, with this process's terminal, and answers how it ended. */
export async function install(provider: Provider): Promise<number> {
  const env = await environment();
  return new Promise((resolve) => {
    // Each installer is a download piped to a shell, which ends well on nothing when the download fails, so the pipe fails with it.
    const child = spawn("/bin/bash", ["-o", "pipefail", "-c", PROGRAMS[provider].installer], { env, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (status) => resolve(status ?? 1));
  });
}
