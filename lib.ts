/**
 * Shared helpers used by both run-e2e.ts and run-dev-server.ts: finding/starting a local scada-ui
 * dev server, and connecting to a given ap's OpenVPN tunnel.
 */
import { ChildProcess, spawn } from "child_process";
import { existsSync, readdirSync } from "fs";
import net from "net";
import { homedir } from "os";
import { join } from "path";

export const DEV_SERVER_PORT = 4200;
export const DEV_SERVER_START_TIMEOUT_MS = 120_000;
export const MAX_PORT_SEARCH_ATTEMPTS = 20;

// Directory of the (separate, personal/team) nx-config checkout that holds the per-ap OpenVPN
// profiles used to connect to a given ap (see nxap.sh/nxap/*.ovpn in that repo). Overridable via
// NX_CONFIG_DIR in case your checkout lives somewhere else.
export const NX_CONFIG_DIR = process.env.NX_CONFIG_DIR ?? join(homedir(), "nordex", "nx-config");
export const NXAP_DIR = join(NX_CONFIG_DIR, "nxap");
export const VPN_CONNECT_TIMEOUT_MS = 30_000;

export function assertRunningFromProjectRoot(rootDir: string): void {
  if (!existsSync(join(rootDir, "angular.json"))) {
    console.error(
      `This script must be run from the root of a scada-ui checkout (the directory containing angular.json). ` +
        `Currently running from: ${rootDir}`,
    );
    process.exit(1);
  }
}

export function getAvailableAps(configDir: string): string[] {
  return readdirSync(configDir)
    .map((file) => /^config\.(.+)\.properties$/.exec(file)?.[1])
    .filter((ap): ap is string => !!ap && ap !== "mock");
}

export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "localhost" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Finds a free port to run our own dev server on, starting at `preferredPort`. If that port is
 * already occupied (e.g. by another dev server you're already using elsewhere), this leaves it
 * untouched and picks the next free port instead, so this script never disturbs a pre-existing
 * server.
 */
export async function findAvailablePort(preferredPort: number): Promise<number> {
  let port = preferredPort;
  while (await isPortInUse(port)) {
    port++;
    if (port > preferredPort + MAX_PORT_SEARCH_ATTEMPTS) {
      throw new Error(
        `Could not find a free port near ${preferredPort} after ${MAX_PORT_SEARCH_ATTEMPTS} attempts.`,
      );
    }
  }
  return port;
}

export async function waitForServerReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      // server not ready yet, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Dev server did not become ready at ${url} within ${timeoutMs}ms`);
}

/**
 * Finds the pids of any processes currently listening on `port` (via `lsof`), on macOS/Linux.
 */
export async function findPidsListeningOnPort(port: number): Promise<number[]> {
  const { stdout } = await runCommand("lsof", ["-ti", `tcp:${port}`]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid));
}

/**
 * Best-effort description (command name) of the process with the given pid, for logging purposes
 * only, e.g. so the user can see what's actually being stopped on their behalf. Falls back to a
 * generic placeholder if the process has already exited or `ps` is unavailable.
 */
async function describeProcess(pid: number): Promise<string> {
  try {
    const { stdout } = await runCommand("ps", ["-p", String(pid), "-o", "comm="]);
    const command = stdout.trim();
    return command ? `pid ${pid}, ${command}` : `pid ${pid}`;
  } catch {
    return `pid ${pid}`;
  }
}

/**
 * Sends `signal` to `pid`, treating "no such process" (i.e. it already exited) as a non-issue but
 * logging anything else unexpected (e.g. a permissions error) rather than silently swallowing it.
 */
function killProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(`Failed to send ${signal} to pid ${pid}: ${(error as Error).message}`);
    }
  }
}

/**
 * Stops whatever process (if any) is currently listening on `port`, so we can reuse it ourselves.
 * Tries SIGTERM first, waiting up to 10s for the port to free up, then falls back to SIGKILL for
 * anything still listening. No-ops if nothing is listening on `port`.
 *
 * Note this isn't limited to processes we started ourselves - it will stop whatever happens to be
 * bound to `port`, logging what it's stopping so the user can spot anything unexpected.
 */
export async function stopServerOnPort(port: number): Promise<void> {
  const pids = await findPidsListeningOnPort(port);
  if (pids.length === 0) {
    return;
  }

  const descriptions = await Promise.all(pids.map(describeProcess));
  console.log(`Stopping existing process(es) on port ${port}: ${descriptions.join("; ")}...`);
  for (const pid of pids) {
    killProcess(pid, "SIGTERM");
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const remainingPids = await findPidsListeningOnPort(port);
  if (remainingPids.length > 0) {
    const remainingDescriptions = await Promise.all(remainingPids.map(describeProcess));
    console.log(
      `Process(es) on port ${port} didn't stop gracefully, force-killing: ${remainingDescriptions.join("; ")}...`,
    );
    for (const pid of remainingPids) {
      killProcess(pid, "SIGKILL");
    }
  }
}

export function startDevServer(ap: string, port: number, rootDir: string): ChildProcess {
  console.log(`Starting dev server (npm run start-${ap} -- --port ${port}) ...`);
  return spawn("npm", ["run", `start-${ap}`, "--", "--port", String(port)], {
    cwd: rootDir,
    stdio: "inherit",
    // Detach so we get our own process group and can kill the whole tree (ng serve spawns
    // further child processes) instead of only the shell.
    detached: true,
  });
}

export interface DevServer {
  process: ChildProcess;
  url: string;
  port: number;
}

/**
 * Starts the dev server for the given ap and waits until it's reachable. Used by both run-e2e.ts
 * (when it needs to start its own dev server) and run-dev-server.ts.
 *
 * By default (`newServer: false`), reuses `preferredPort` by stopping whatever server (if any) is
 * already listening on it first, so the dev server always ends up on the standard Angular dev
 * server port. Pass `newServer: true` to instead leave any existing server on `preferredPort`
 * untouched and pick the next free port instead (see findAvailablePort), so multiple dev servers
 * can run side-by-side.
 *
 * Fails fast (rather than waiting out the full timeout) if the dev server process exits before
 * becoming reachable, e.g. due to a startup crash.
 */
export async function startAndWaitForDevServer(
  ap: string,
  rootDir: string,
  preferredPort: number,
  options: { newServer?: boolean } = {},
): Promise<DevServer> {
  let port: number;
  if (options.newServer) {
    port = await findAvailablePort(preferredPort);
    if (port !== preferredPort) {
      console.log(
        `Port ${preferredPort} is already in use, starting the dev server on port ${port} instead.`,
      );
    }
  } else {
    await stopServerOnPort(preferredPort);
    port = preferredPort;
  }

  const url = `http://localhost:${port}`;
  const devServerProcess = startDevServer(ap, port, rootDir);

  await Promise.race([
    waitForServerReady(url, DEV_SERVER_START_TIMEOUT_MS),
    new Promise<never>((_resolve, reject) => {
      devServerProcess.once("exit", (code) => {
        reject(new Error(`Dev server exited with code ${code ?? 1} before becoming ready.`));
      });
    }),
  ]);

  return { process: devServerProcess, url, port };
}

export function stopChildProcessTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }

    child.once("exit", () => resolve());
    // safety net in case the process doesn't exit in time
    const forceResolveTimeout = setTimeout(resolve, 10_000);
    child.once("exit", () => clearTimeout(forceResolveTimeout));

    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  });
}

/**
 * Creates an idempotent `cleanupAndExit(exitCode)` function that runs the given cleanup steps in
 * order (once, even if called multiple times concurrently, e.g. from both a signal handler and a
 * failure path) and then exits the process. Steps are responsible for guarding against/no-oping
 * on already-cleaned-up state themselves.
 */
export function createCleanupHandler(
  steps: Array<() => Promise<void>>,
): (exitCode: number) => Promise<never> {
  let cleanupPromise: Promise<never> | undefined;

  return function cleanupAndExit(exitCode: number): Promise<never> {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = (async (): Promise<never> => {
      for (const step of steps) {
        await step();
      }
      process.exit(exitCode);
    })();
    return cleanupPromise;
  };
}

/**
 * Converts an ap name like "ap09" to the corresponding openvpn config name "ap9" used by the
 * nx-config nxap/*.ovpn profiles (which don't zero-pad the ap number).
 */
export function toOvpnConfigName(ap: string): string {
  const match = /^ap0*(\d+)$/.exec(ap);
  if (!match) {
    throw new Error(`Unable to derive an openvpn config name from "${ap}"`);
  }
  return `ap${match[1]}`;
}

export interface AzureDevOpsRepoContext {
  organization: string;
  project: string;
  repository: string;
}

/**
 * Parses an Azure DevOps org/project/repo out of a git remote URL, supporting the HTTPS
 * (dev.azure.com and legacy *.visualstudio.com) and SSH remote formats Azure Repos hands out.
 */
export function parseAzureDevOpsRemote(remoteUrl: string): AzureDevOpsRepoContext {
  const patterns = [
    // https://dev.azure.com/{org}/{project}/_git/{repo} (optionally with a "{org}@" prefix, as
    // used for HTTPS credential prompts)
    /^https:\/\/(?:[^/@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/,
    // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    // https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo} (legacy)
    /^https:\/\/([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(remoteUrl);
    if (match) {
      const [, organization, project, repository] = match;
      return {
        organization: decodeURIComponent(organization),
        project: decodeURIComponent(project),
        repository: decodeURIComponent(repository),
      };
    }
  }

  throw new Error(
    `Could not parse an Azure DevOps organization/project/repository from remote URL: "${remoteUrl}"`,
  );
}

export function runCommand(
  command: string,
  args: string[],
  options: { inheritTerminal?: boolean; detached?: boolean } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    // When a command may need to interact with the user (e.g. a sudo password prompt), inherit
    // stdin/stderr so it can read/write directly to the real terminal, while still piping stdout
    // so we can inspect it.
    const child = spawn(command, args, {
      stdio: options.inheritTerminal ? ["inherit", "pipe", "inherit"] : "pipe",
      detached: options.detached,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/**
 * Returns the openvpn config names (e.g. "ap9") of any currently running nxap OpenVPN tunnels,
 * by looking for "openvpn --config apN.ovpn" processes.
 */
export async function getConnectedApConfigNames(): Promise<string[]> {
  const { stdout } = await runCommand("pgrep", ["-fl", "openvpn --config ap"]);
  const configNames = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /openvpn --config (ap\d+)\.ovpn/.exec(line);
    if (match) {
      configNames.add(match[1]);
    }
  }
  return [...configNames];
}

/**
 * Detects which (if any) of the given `availableAps` we're currently connected to via VPN, by
 * matching the running openvpn tunnels' config names (see getConnectedApConfigNames) against each
 * ap's corresponding config name. Returns undefined if no ap's tunnel is currently connected.
 *
 * Used to default `--ap` to "whichever ap you're already connected to" when it's not passed
 * explicitly.
 */
export async function detectConnectedAp(availableAps: string[]): Promise<string | undefined> {
  const connectedConfigNames = await getConnectedApConfigNames();
  if (connectedConfigNames.length === 0) {
    return undefined;
  }
  return availableAps.find((ap) => connectedConfigNames.includes(toOvpnConfigName(ap)));
}

export async function disconnectApVpns(configNames: string[]): Promise<void> {
  for (const configName of configNames) {
    console.log(`Disconnecting existing ${configName} VPN tunnel...`);
    // -S: read the sudo password from stdin rather than /dev/tty, since that may not be available
    // (e.g. detached child processes have no controlling terminal).
    // detached: matches connectApVpn's session context (see comment there) so that, if this is the
    // first sudo call and the one that captures the password, its credential cache is recognized
    // by the later (also detached) "sudo openvpn" call below instead of prompting a second time.
    await runCommand("sudo", ["-S", "pkill", "-f", `openvpn --config ${configName}.ovpn`], {
      inheritTerminal: true,
      detached: true,
    });
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await getConnectedApConfigNames()).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the existing VPN tunnel(s) to disconnect.");
}

/**
 * Connects to the given ap's OpenVPN tunnel via the nxap.sh-equivalent "sudo openvpn --config
 * <ap>.ovpn ..." command, leaving it running in the background once connected. Callers are
 * responsible for tearing it back down later if appropriate.
 */
export async function connectApVpn(configName: string): Promise<void> {
  const configFile = `${configName}.ovpn`;
  if (!existsSync(join(NXAP_DIR, configFile))) {
    throw new Error(
      `Could not find openvpn config "${configFile}" in ${NXAP_DIR}. Set NX_CONFIG_DIR if your nx-config checkout lives elsewhere.`,
    );
  }

  console.log(`Connecting to ${configName}'s VPN (sudo openvpn --config ${configFile})...`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "sudo",
      // -S: read the sudo password from stdin rather than /dev/tty. Detaching (below) starts a new
      // session with no controlling terminal, so /dev/tty is unavailable and sudo must be told to
      // use stdin instead, which remains inherited from the real terminal.
      [
        "-S",
        "openvpn",
        "--config",
        configFile,
        "--connect-timeout",
        "5",
        "--connect-retry-max",
        "5",
        "--script-security",
        "3",
        "--tun-mtu",
        "1200",
      ],
      {
        cwd: NXAP_DIR,
        // Keep stdin/stderr attached to the terminal so sudo's password prompt still works;
        // pipe stdout so we can watch for openvpn's own readiness message.
        stdio: ["inherit", "pipe", "inherit"],
        // Detach so this tunnel keeps running independently of our own script/process group. Note
        // this also means sudo sees no controlling terminal here, same as disconnectApVpns'
        // (also detached) "sudo pkill" call above - keeping both sudo invocations in the same
        // (tty-less) session context lets sudo reuse a single cached credential across both,
        // rather than prompting for the password twice.
        detached: true,
      },
    );

    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for the ${configName} VPN tunnel to connect.`));
    }, VPN_CONNECT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (text.includes("Initialization Sequence Completed")) {
        clearTimeout(timeout);
        child.stdout?.destroy();
        child.unref();
        resolve();
      }
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`openvpn exited with code ${code} while connecting to ${configName}.`));
      }
    });
  });

  console.log(`Connected to ${configName}'s VPN.`);
}

/**
 * Ensures we're connected to the requested ap's OpenVPN tunnel, disconnecting any other ap's
 * tunnel first if one is active. Leaves an already-matching connection untouched.
 *
 * Returns the openvpn config name if this call itself changed the VPN connection state (i.e.
 * disconnected another ap and/or connected this one), meaning the caller is responsible for
 * tearing that tunnel back down later. Returns undefined if an already-matching connection was
 * found and left as-is.
 */
export async function ensureConnectedToApVpn(ap: string): Promise<string | undefined> {
  const desiredConfigName = toOvpnConfigName(ap);
  const connectedConfigNames = await getConnectedApConfigNames();

  if (connectedConfigNames.includes(desiredConfigName)) {
    console.log(
      `Already connected to ${ap}'s VPN (${desiredConfigName}), leaving the existing connection as-is.`,
    );
    return undefined;
  }

  if (connectedConfigNames.length > 0) {
    await disconnectApVpns(connectedConfigNames);
  }

  await connectApVpn(desiredConfigName);
  // We changed the VPN connection state ourselves, so we're responsible for tearing it back down
  // once the caller is done.
  return desiredConfigName;
}

export interface VpnTeardownController {
  /**
   * Records the config name returned by `ensureConnectedToApVpn` (or undefined), i.e. the tunnel
   * we're responsible for tearing back down, if any.
   */
  setPendingTearDown(configName: string | undefined): void;
  /**
   * Records whether the tunnel we established should actually be disconnected once we're done
   * (as opposed to left connected for reuse next time). Should be called once, up front, before
   * any cleanup step can possibly run.
   */
  setShouldDisconnect(shouldDisconnect: boolean): void;
  /**
   * Cleanup step suitable for passing directly to `createCleanupHandler`: disconnects the tunnel
   * we established, if any, and if `setShouldDisconnect(true)` was called. No-ops otherwise
   * (e.g. an already-matching pre-existing connection, or the user opted to leave it running).
   */
  cleanupStep(): Promise<void>;
}

/**
 * Creates a controller that tracks "which VPN tunnel (if any) did we establish, and should we
 * tear it down again once we're done", shared between run-dev-server.ts and run-e2e.ts.
 */
export function createVpnTeardownController(): VpnTeardownController {
  let configNameToTearDown: string | undefined;
  let shouldDisconnect = false;

  return {
    setPendingTearDown(configName: string | undefined): void {
      configNameToTearDown = configName;
    },
    setShouldDisconnect(value: boolean): void {
      shouldDisconnect = value;
    },
    async cleanupStep(): Promise<void> {
      if (!shouldDisconnect || !configNameToTearDown) {
        return;
      }
      const configName = configNameToTearDown;
      configNameToTearDown = undefined;
      try {
        await disconnectApVpns([configName]);
      } catch (error) {
        console.error(
          `Failed to disconnect the ${configName} VPN tunnel we established: ${(error as Error).message}`,
        );
      }
    },
  };
}
