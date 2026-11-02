/**
 * The runner as a service, so it starts at login and comes back when it crashes: a launchd agent
 * on macOS, a `systemd --user` unit with linger on Linux, so it runs with no one logged in. Each
 * runs `ky runner run`, logging to the state dir's runner.log. A runner ky turns away exits 0, and
 * neither restarts it.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { System } from "./system.ts";
import { toEnv } from "../../src/machines/contract.ts";

export type Service = {
  /** Its plist or unit file. */
  file: string;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  uninstall: () => Promise<void>;
  /** Whether it is loaded (launchd) or active (systemd). */
  loaded: () => Promise<boolean>;
};

export function logFile(system: System): string {
  return path.join(system.state, "runner.log");
}

/**
 * Where the service keeps things when it isn't the default: KY_STATE_DIR and XDG_CONFIG_HOME as
 * this `ky` resolved them. Each install writes the service file fresh from these, so a trial's
 * setting is gone once `ky runner add` runs without it.
 */
export function serviceDirs(system: System) {
  // A second runner's state is <state dir>/<as>; KY_RUNNER_AS adds the <as> again.
  const state = system.instance ? path.dirname(system.state) : system.state;

  return {
    ...(system.config !== path.join(system.home, ".config") && { XDG_CONFIG_HOME: system.config }),
    ...(state !== path.join(system.home, ".ky") && toEnv({ STATE_DIR: state }))
  };
}

/** What the service runs with besides its own environment: this shell's PATH, so it finds `claude` and `codex`, where ky keeps things, and which runner it is. */
function environment(system: System) {
  return { PATH: system.path, HOME: system.home, ...toEnv({ RUNNER_SERVICE: "1" }), ...serviceDirs(system), ...(system.instance && toEnv({ RUNNER_AS: system.instance })) };
}

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function plist(system: System): string {
  const log = xml(logFile(system));
  const strings = (values: string[]) => values.map((value) => `    <string>${xml(value)}</string>`).join("\n");

  const env = Object.entries(environment(system))
    .map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(system.label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings([...system.ky, "runner", "run"])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

/** A word of systemd's command line, quoted. */
const quoted = (word: string) => `"${word.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function unit(system: System): string {
  const log = logFile(system);

  const env = Object.entries(environment(system))
    .map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}`)
    .join("\n");

  return `[Unit]
Description=ky runner${system.instance ? ` (${system.instance})` : ""}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[...system.ky, "runner", "run"].map(quoted).join(" ")}
${env}
Restart=on-failure
RestartSec=10
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

/** How long `install` waits for launchd to finish stopping the service it replaces. */
const STOPPED_WITHIN_MS = 10_000;

const STOP_POLL_MS = 200;

/** Waits until launchd no longer has `target`: bootout returns before the job is gone, and bootstrap fails with "5: Input/output error" until it is. */
async function stopped(system: System, target: string): Promise<void> {
  for (let waited = 0; waited < STOPPED_WITHIN_MS; waited += STOP_POLL_MS) {
    if ((await system.exec("launchctl", ["print", target])).code !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
}

/** Runs a service manager's command, throwing what it said when it fails. */
async function must(system: System, command: string, args: string[]): Promise<void> {
  const ran = await system.exec(command, args);

  if (ran.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(ran.stderr || ran.stdout).trim() || `exit ${ran.code}`}`);
}

function launchd(system: System): Service {
  const file = path.join(system.launchAgents, `${system.label}.plist`);
  const domain = `gui/${system.uid}`;
  const target = `${domain}/${system.label}`;

  return {
    file,
    install: async () => {
      await mkdir(system.launchAgents, { recursive: true });
      await mkdir(system.state, { recursive: true });
      await writeFile(file, plist(system));
      // One already loaded is replaced: bootout fails when there is none, which is fine.
      await system.exec("launchctl", ["bootout", target]);
      await stopped(system, target);
      await must(system, "launchctl", ["bootstrap", domain, file]);
    },
    restart: () => must(system, "launchctl", ["kickstart", "-k", target]),
    uninstall: async () => {
      await system.exec("launchctl", ["bootout", target]);
      await rm(file, { force: true });
    },
    loaded: async () => (await system.exec("launchctl", ["print", target])).code === 0
  };
}

function systemd(system: System): Service {
  const name = `${system.label}.service`;
  const file = path.join(system.systemdUnits, name);

  return {
    file,
    install: async () => {
      await mkdir(system.systemdUnits, { recursive: true });
      await mkdir(system.state, { recursive: true });
      await writeFile(file, unit(system));
      await must(system, "systemctl", ["--user", "daemon-reload"]);
      await must(system, "systemctl", ["--user", "enable", "--now", name]);
      // A restart picks up a unit that changed while it ran.
      await must(system, "systemctl", ["--user", "restart", name]);
      // Linger keeps the user's services running with no one logged in; without it the runner stops at logout.
      await must(system, "loginctl", ["enable-linger", system.user]);
    },
    restart: () => must(system, "systemctl", ["--user", "restart", name]),
    uninstall: async () => {
      await system.exec("systemctl", ["--user", "disable", "--now", name]);
      await rm(file, { force: true });
      await system.exec("systemctl", ["--user", "daemon-reload"]);
    },
    loaded: async () => (await system.exec("systemctl", ["--user", "is-active", "--quiet", name])).code === 0
  };
}

/** This computer's service manager, or undefined where ky has none (Windows). */
export function service(system: System): Service | undefined {
  if (system.platform === "darwin") return launchd(system);

  if (system.platform === "linux") return systemd(system);

  return undefined;
}
