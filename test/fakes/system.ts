/**
 * A fake computer for `ky runner`: a temporary home, config and state dir, and fakes of the
 * programs the runner commands run, so a test never touches the user's Keychain, launchd agents,
 * systemd units or ~/.config/ky.
 *
 *   security   a Keychain in memory: `-i` with add-generic-password on stdin, find- and delete-generic-password
 *   launchctl  bootstrap, bootout, kickstart and print, over a set of loaded labels; a job booted out
 *              lingers for `lingers` prints, and bootstrap fails with launchd's error 5 until it's gone
 *   systemctl  --user daemon-reload, enable --now, restart, disable --now and is-active, the same way
 *   loginctl   enable-linger
 *   cloudflared  access token, and access login, which signs in with `accessLogin`
 *
 * Starting the service "runs" the runner: `online` says what it writes to the status file, as
 * `ky runner run` would once ky took its socket.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Exec, Ran, System } from "../../cli/runner/system.ts";

export type FakeSystem = System & {
  /** Every command run, as `command arg …`. */
  ran: string[];
  /** The Keychain: `service/account` to password. */
  keychain: Map<string, string>;
  /** Labels loaded into launchd, or units active in systemd. */
  loaded: Set<string>;
  /** How many `launchctl print`s still find a job after bootout, as launchd stops it in the background. */
  lingers: number;
  /** What the runner the service starts says: online, or turned away. */
  online: "online" | "stopped" | "never";
  /** Ports something listens on. */
  ports: Set<number>;
  hasChrome: boolean;
  /** What `cloudflared access token` prints; undefined when signed out of Access. */
  accessToken: string | undefined;
  /** The token `cloudflared access login` signs in with; undefined when the sign-in fails. */
  accessLogin: string | undefined;
};

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });

const failed = (stderr: string, code = 1): Ran => ({ code, stdout: "", stderr });

/** `-s "x" -a "y" -w "z"` from security's interactive line. */
function quotedFlags(line: string): Map<string, string> {
  return new Map([...line.matchAll(/-([saw]) "([^"]*)"/g)].map((match) => [match[1]!, match[2]!]));
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);

  return at === -1 ? undefined : args[at + 1];
}

export async function fakeSystem(platform: NodeJS.Platform = "darwin"): Promise<FakeSystem> {
  const root = await mkdtemp(path.join(tmpdir(), "ky-runner-"));
  const home = path.join(root, "home");
  const state = path.join(home, ".ky");

  mkdirSync(home, { recursive: true });

  /** The runner `label` starts writes its status to its state dir: a second runner's (`<label>.<as>`) is <state>/<as>. */
  const started = (label: string) => {
    if (fake.online === "never") return;
    const as = label.startsWith(`${fake.label}.`) || label.startsWith(`${fake.label}-`) ? label.slice(fake.label.length + 1) : undefined;
    const dir = as ? path.join(fake.state, as) : fake.state;
    mkdirSync(dir, { recursive: true });
    const status = { state: fake.online, machine: "fake", url: "", version: "test", pid: process.pid, at: Date.now(), ...(fake.online === "stopped" && { reason: "removed from ky" }) };
    writeFileSync(path.join(dir, "runner-status.json"), JSON.stringify(status));
  };

  const security = (args: string[], input = ""): Ran => {
    if (args[0] === "-i") {
      const flags = quotedFlags(input);

      if (!input.startsWith("add-generic-password")) return failed("unknown command");
      fake.keychain.set(`${flags.get("s")}/${flags.get("a")}`, flags.get("w") ?? "");

      return ok();
    }

    const key = `${flag(args, "-s")}/${flag(args, "-a")}`;

    if (args[0] === "find-generic-password") {
      const password = fake.keychain.get(key);

      return password === undefined ? failed("The specified item could not be found in the keychain.", 44) : ok(`${password}\n`);
    }

    if (args[0] === "delete-generic-password") return fake.keychain.delete(key) ? ok() : failed("not found", 44);

    return failed("unknown command");
  };

  /** A loaded label's verb: `then` it, else launchd's "Could not find service". */
  const ifLoaded = (label: string, then: () => void = () => {}): Ran => {
    if (!fake.loaded.has(label)) return failed("Could not find service", 113);
    then();

    return ok();
  };

  /** Jobs booted out but not yet gone: label to the prints that still find them. */
  const stopping = new Map<string, number>();

  // Each verb with the label its last argument names: `gui/<uid>/<label>`, or bootstrap's plist.
  const launchd = new Map<string, (label: string) => Ran>([
    [
      "bootstrap",
      (label) => {
        if (stopping.has(label)) return failed("Bootstrap failed: 5: Input/output error", 5);
        fake.loaded.add(label);
        started(label);

        return ok();
      }
    ],
    [
      "bootout",
      (label) => {
        if (!fake.loaded.delete(label)) return failed("No such process", 3);

        if (fake.lingers > 0) stopping.set(label, fake.lingers);

        return ok();
      }
    ],
    ["kickstart", (label) => ifLoaded(label, () => started(label))],
    [
      "print",
      (label) => {
        const left = stopping.get(label);

        if (left === undefined) return ifLoaded(label);

        if (left <= 1) stopping.delete(label);
        else stopping.set(label, left - 1);

        return ok();
      }
    ]
  ]);

  const launchctl = (args: string[]): Ran => {
    const last = args.at(-1) ?? "";
    const label = last.endsWith(".plist") ? path.basename(last, ".plist") : (last.split("/").at(-1) ?? "");

    return launchd.get(args[0] ?? "")?.(label) ?? failed("unknown verb");
  };

  const systemctl = (args: string[]): Ran => {
    const words = args.filter((arg) => !arg.startsWith("--"));
    const [verb] = words;
    const unit = (words.at(-1) ?? "").replace(/\.service$/, "");

    switch (verb) {
      case "daemon-reload":
        return ok();
      case "enable":
      case "restart":
        fake.loaded.add(unit);
        started(unit);

        return ok();
      case "disable":
        fake.loaded.delete(unit);

        return ok();
      case "is-active":
        return fake.loaded.has(unit) ? ok("active") : failed("inactive", 3);
      default:
        return failed("unknown verb");
    }
  };

  const cloudflared = (args: string[]): Ran => {
    if (args[1] === "login") {
      if (fake.accessLogin === undefined) return failed("failed to sign in");
      fake.accessToken = fake.accessLogin;

      return ok(`${fake.accessToken}\n`);
    }

    return fake.accessToken === undefined ? failed("Unable to find token for provided application.") : ok(`${fake.accessToken}\n`);
  };

  const programs = new Map<string, (args: string[], input?: string) => Ran>([
    ["security", security],
    ["launchctl", launchctl],
    ["systemctl", systemctl],
    ["loginctl", () => ok()],
    ["cloudflared", cloudflared]
  ]);

  const exec: Exec = async (command, args, input) => {
    fake.ran.push([command, ...args].join(" "));

    return programs.get(command)?.(args, input) ?? failed(`${command}: not found`, 127);
  };

  const fake: FakeSystem = {
    platform,
    home,
    user: "someone",
    uid: 501,
    config: path.join(home, ".config"),
    state,
    label: platform === "darwin" ? "test.ky.runner" : "ky-runner-test",
    launchAgents: path.join(home, "Library", "LaunchAgents"),
    systemdUnits: path.join(home, ".config", "systemd", "user"),
    ky: ["/opt/ky/bin/ky"],
    path: "/opt/homebrew/bin:/usr/bin:/bin",
    exec,
    listening: async (port) => fake.ports.has(port),
    chrome: () => fake.hasChrome,
    ports: new Set(),
    hasChrome: false,
    accessToken: "access-token",
    accessLogin: "access-token",
    ran: [],
    keychain: new Map(),
    loaded: new Set(),
    lingers: 0,
    online: "online"
  };

  return fake;
}
