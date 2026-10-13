import { join } from "node:path";
import { IdentityStore } from "./identity.js";
import { DockerEngine } from "./docker-runtime.js";
import { existsSync } from "node:fs";
import { ChromiumEngine } from "./browser.js";
import { ProfileStore } from "./profiles.js";
import { DesktopEngine } from "./desktop.js";
import { readConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { SessionRegistry } from "./sessions.js";

if (existsSync(".env")) process.loadEnvFile(".env");
let config: ReturnType<typeof readConfig>;
try {
  config = readConfig();
} catch {
  console.error(
    "Invalid configuration. Check .env.example; legacy mode requires AGENT_BROWSER_TOKEN, and team mode requires BROWSER_MODE=docker.",
  );
  process.exit(1);
}
const engine =
  config.browserMode === "docker"
    ? new DockerEngine({ dataDirectory: config.dataDirectory, image: config.runtimeImage, network: config.runtimeNetwork,
        volume: config.runtimeVolume,
        denyHosts: [...new Set([new URL(config.publicUrl).hostname.replace(/^\[|\]$/g, ''), ...config.egressDenyHosts])] })
    : config.browserMode === "desktop"
    ? new DesktopEngine({ executablePath: config.desktopChromePath, profiles: new ProfileStore(config.dataDirectory) })
    : new ChromiumEngine({
        headless: config.headless,
        executablePath: config.executablePath,
      });
if (engine instanceof DockerEngine) {
  try { await engine.initialize(); }
  catch { console.error("Unable to initialize isolated runtime controller. Check Docker, image, data-directory ownership and cleanup records."); process.exit(1); }
}
const registry = new SessionRegistry(engine, config);
const identity = config.authMode !== "legacy" ? new IdentityStore(join(config.dataDirectory, "identity")) : undefined;
const server = createHttpServer(registry, { ...config, identity, demo: config.authMode === "demo", publicBrowser: config.authMode === "public", defaultStartUrl: config.browserMode === 'docker' ? 'https://agentic-browser.invalid/demo' : undefined });
const reapTimer = setInterval(() => {
  void registry.reap();
  if (identity) { identity.reap(); void registry.closeInactiveMembers(owner => identity.isActive(owner)); }
  if (engine instanceof DockerEngine) void engine.reap().catch(() => console.error("Runtime cleanup pending; retained private resource records for retry."));
}, 5000).unref();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(reapTimer);
  server.close();
  await server.closeRemoteMcp();
  await registry.close();
  server.closeAllConnections();
  identity?.close();
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
server.on("error", () => {
  console.error("Unable to start HTTP service; check HOST and PORT.");
  process.exitCode = 1;
  void shutdown();
});
server.listen(config.port, config.host, () => {
  console.log(`Agentic Browser is ready at ${config.publicUrl}`);
});
