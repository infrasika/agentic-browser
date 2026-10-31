import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { ChromiumWorkspace } from "./browser.js";
import { ProxyNetworkState } from "./proxy-network-state.js";
import {
  ServiceError,
  type Actor,
  type BrowserAction,
  type BrowserWorkspace,
} from "./contracts.js";

const exec = promisify(execFile);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function stop(child?: ChildProcess) {
  if (!child?.pid) return;
  // Every component owns its own process group, including Chrome's children.
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {}
  };
  kill("SIGTERM");
  if (child.exitCode !== null || child.signalCode !== null) return;
  const timer = setTimeout(() => kill("SIGKILL"), 2000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timer);
  }
}

export class DesktopWorkspace implements BrowserWorkspace {
  readonly transport = "desktop" as const;
  private children: ChildProcess[] = [];
  private environment: NodeJS.ProcessEnv = {};
  private endpoint = "";
  private browser?: Browser;
  private networkState?: ProxyNetworkState;
  private automation?: ChromiumWorkspace;
  private vnc?: ChildProcess;
  private vncPort = 0;
  private human = false;
  private sockets = new Set<Socket>();
  private closing?: Promise<void>;
  private disposed = false;

  constructor(private directory: string) {}

  private async launch(command: string, args: string[], displayFd = false) {
    if (this.disposed) throw new Error("Desktop is closed");
    const child = spawn(command, args, {
      env: this.environment,
      stdio: displayFd ? ["ignore", "ignore", "ignore", "pipe"] : "ignore",
      detached: true,
    });
    this.children.push(child);
    child.on("error", () => {});
    await once(child, "spawn");
    return child;
  }

  private async ready(check: () => Promise<boolean>, child: ChildProcess) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (this.disposed || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Desktop component stopped during startup");
      if (await check()) return;
      await delay(100);
    }
    throw new Error("Desktop component startup timed out");
  }

  async start(executablePath: string, chromeArgs: string[] = [], publicEgress = false) {
    if (process.platform !== "linux")
      throw new ServiceError(
        503,
        "desktop_requires_linux",
        "Desktop mode requires Linux, Xvfb, xauth, openbox and x11vnc",
      );
    const homeDirectory = join(this.directory, "home");
    await mkdir(homeDirectory, { mode: 0o700 });
    this.environment = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8", HOME: homeDirectory, TMPDIR: this.directory,
      XDG_CONFIG_HOME: join(homeDirectory, ".config"),
      XDG_CACHE_HOME: join(homeDirectory, ".cache"),
      LIBGL_ALWAYS_SOFTWARE: "1",
      GALLIUM_DRIVER: "llvmpipe",
    };
    const auth = join(this.directory, "Xauthority");
    const cookie = randomBytes(16).toString("hex");
    await writeFile(auth, "", { mode: 0o600 });
    await exec(
      "xauth",
      ["-f", auth, "add", ":0", "MIT-MAGIC-COOKIE-1", cookie],
      { timeout: 5000, env: this.environment },
    );
    const display = await this.launch(
      "Xvfb",
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        "1280x900x24",
        "-nolisten",
        "tcp",
        "-auth",
        auth,
      ],
      true,
    );
    let displayNumber = "";
    (display.stdio[3] as Readable).setEncoding("utf8").on("data", (chunk) => {
      displayNumber += chunk;
    });
    await this.ready(async () => /^\d+\n$/.test(displayNumber), display);
    this.environment = {
      ...this.environment,
      DISPLAY: `:${displayNumber.trim()}`,
      XAUTHORITY: auth,
    };
    await exec(
      "xauth",
      [
        "-f",
        auth,
        "add",
        this.environment.DISPLAY!,
        "MIT-MAGIC-COOKIE-1",
        cookie,
      ],
      { timeout: 5000, env: this.environment },
    );

    // A minimal WM gives Chrome a stable size without desktop launchers/shortcuts.
    const wmConfig = join(this.directory, "openbox.xml");
    await writeFile(
      wmConfig,
      '<openbox_config xmlns="http://openbox.org/3.4/rc"><applications><application class="*"><maximized>yes</maximized></application></applications></openbox_config>',
    );
    await this.launch("openbox", ["--config-file", wmConfig]);
    const profile = join(this.directory, "profile");
    await mkdir(join(profile, "Default"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(profile, "Default", "Preferences"),
      JSON.stringify({
        credentials_enable_service: false,
        profile: { password_manager_enabled: false },
        download: {
          default_directory: join(this.directory, "downloads"),
          prompt_for_download: true,
        },
      }),
      { mode: 0o600, flag: "wx" },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const port = await freePort();
    const chrome = await this.launch(executablePath, [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "--window-position=0,0",
      // The runtime has no GPU device. Explicitly use Mesa's CPU renderer;
      // Chromium otherwise blocklists software GL, making WebGL sites crash.
      "--use-angle=gl",
      "--ignore-gpu-blocklist",
      ...chromeArgs,
      "about:blank",
    ]);
    this.endpoint = `http://127.0.0.1:${port}`;
    await this.ready(async () => {
      try {
        return (
          await fetch(`${this.endpoint}/json/version`, {
            signal: AbortSignal.timeout(500),
          })
        ).ok;
      } catch {
        return false;
      }
    }, chrome);
    if (publicEgress) {
      this.networkState = await ProxyNetworkState.connect(this.endpoint, () => {
        void this.close().catch(() => {});
      });
      if (this.disposed) { this.networkState.close(); throw new Error("Desktop is closed"); }
    }
    await this.setControl("agent");
  }

  revokeHumanInput() {
    this.human = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    // Stop the native input server before connecting automation again.
    if (this.vnc?.pid) {
      try {
        process.kill(-this.vnc.pid, "SIGTERM");
      } catch {}
    }
  }

  async setControl(actor: Actor) {
    if (this.disposed) throw new Error("Desktop is closed");
    this.revokeHumanInput();
    await stop(this.vnc);
    this.vnc = undefined;
    if (actor === "agent") {
      if (!this.browser) {
        const browser = await chromium.connectOverCDP(this.endpoint, {
          timeout: 10000,
          noDefaults: true,
        });
        if (this.disposed) {
          await browser.close();
          throw new Error("Desktop is closed");
        }
        this.browser = browser;
        const context = browser.contexts()[0];
        context.setDefaultTimeout(8000);
        context.setDefaultNavigationTimeout(15000);
        if (context.pages().length === 0) await context.newPage();
        this.automation = new ChromiumWorkspace(context);
        await this.automation.adoptVisiblePage();
      }
      return;
    }
    this.automation = undefined;
    const browser = this.browser;
    this.browser = undefined;
    // For a CDP-connected browser close() disconnects this client; Chrome lives on.
    if (browser) await browser.close();
    this.vncPort = await freePort();
    this.vnc = await this.launch("x11vnc", [
      "-display",
      this.environment.DISPLAY!,
      "-auth",
      this.environment.XAUTHORITY!,
      "-listen",
      "127.0.0.1",
      "-rfbport",
      String(this.vncPort),
      "-no6",
      "-nopw",
      "-forever",
      "-shared",
      "-noxdamage",
      "-repeat",
      "-clear_keys",
      "-quiet",
    ]);
    await this.ready(
      () =>
        new Promise((resolve) => {
          const socket = createConnection({
            host: "127.0.0.1",
            port: this.vncPort,
          });
          socket.on("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.on("error", () => resolve(false));
          socket.setTimeout(500, () => {
            socket.destroy();
            resolve(false);
          });
        }),
      this.vnc,
    );
    if (this.disposed) throw new Error("Desktop is closed");
    this.human = true;
  }

  openDesktop() {
    if (
      !this.human ||
      this.disposed ||
      !this.vnc ||
      this.vnc.exitCode !== null ||
      this.vnc.signalCode !== null
    )
      throw new ServiceError(
        409,
        "control_unavailable",
        "Desktop input is not available",
      );
    if (this.sockets.size >= 4)
      throw new ServiceError(
        429,
        "viewer_limit",
        "Close another viewer before connecting",
      );
    const socket = createConnection({ host: "127.0.0.1", port: this.vncPort });
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  }

  async perform(action: BrowserAction) {
    if (!this.automation || this.human)
      throw new ServiceError(
        409,
        "desktop_input_required",
        "Use the remote desktop while the human is in control",
      );
    return this.automation.perform(action);
  }

  async verifyExtensions(expected: { id: string; version: string }[]) {
    if (!this.browser || this.human) throw new Error('Cannot inspect extension readiness without Agent control');
    const page = await this.browser.contexts()[0].newPage();
    try {
      await page.goto('chrome://extensions');
      for (let attempt = 0; attempt < 60; attempt++) {
        const installed = await page.evaluate(() => new Promise<{ id: string; version: string; state: string }[]>(resolve => {
          (globalThis as any).chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve);
        }));
        if (expected.every(item => installed.some(actual => actual.id === item.id && actual.version === item.version && actual.state === 'ENABLED'))) return;
        await delay(250);
      }
      throw new ServiceError(503, 'extensions_not_ready', 'The required extension versions are not ready. The browser environment was not made available.');
    } finally { await page.close(); }
  }

  async screenshot(maskPasswords = true) {
    if (!this.automation || this.human)
      throw new ServiceError(
        409,
        "desktop_input_required",
        "Use the remote desktop while the human is in control",
      );
    return this.automation.screenshot(maskPasswords);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.disposed = true;
      this.revokeHumanInput();
      this.automation = undefined;
      this.closing = (async () => {
        // Stop browser processes before deleting the disposable workspace.
        for (const child of [...this.children].reverse()) await stop(child);
        this.networkState?.close();
        await this.browser?.close().catch(() => {});
        await rm(this.directory, { recursive: true, force: true });
      })();
    }
    return this.closing;
  }
}
