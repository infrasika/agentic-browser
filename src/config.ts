import { z } from "zod";

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z
    .object({
      AGENT_BROWSER_TOKEN: z.string().min(32).optional(),
      BROWSER_AUTH_MODE: z.enum(["legacy", "team", "demo", "public"]).default("legacy"),
      PUBLIC_MAX_SESSIONS_PER_IP: z.coerce.number().int().min(1).max(8).default(2),
      BROWSER_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
      HOST: z.enum(["127.0.0.1", "::1", "0.0.0.0"]).default("127.0.0.1"),
      PORT: z.coerce.number().int().min(1).max(65535).default(3333),
      PUBLIC_URL: z.string().url().optional(),
      SESSION_TTL_SECONDS: z.coerce
        .number()
        .int()
        .min(60)
        .max(14400)
        .default(1800),
      MAX_SESSIONS: z.coerce.number().int().min(1).max(32).default(4),
      MAX_SESSIONS_PER_MEMBER: z.coerce.number().int().min(1).max(32).default(2),
      SESSION_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(60).max(86400).default(14400),
      CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
      HEADLESS: z.enum(["true", "false"]).default("true"),
      BROWSER_MODE: z.enum(["playwright", "desktop", "docker"]).default("playwright"),
      BROWSER_RUNTIME_IMAGE: z.string().min(1).default("agentic-browser:zkpass-prototype"),
      BROWSER_NETWORK: z.enum(["none", "public"]).default("public"),
      BROWSER_EGRESS_DENY_HOSTS: z.string().default(""),
      BROWSER_DATA_DIR: z.string().min(1).default(".data"),
      BROWSER_DATA_VOLUME: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/).optional(),
      BROWSER_DATA_VOLUME_ROOT: z.string().min(1).optional(),
      DESKTOP_CHROME_PATH: z.string().default("/usr/bin/google-chrome-stable"),
    })
    .parse(env);
  if (parsed.BROWSER_AUTH_MODE === "legacy" && !parsed.AGENT_BROWSER_TOKEN) throw new Error("Legacy mode requires AGENT_BROWSER_TOKEN");
  if (parsed.BROWSER_AUTH_MODE !== "legacy" && parsed.BROWSER_MODE !== "docker") throw new Error("Team and demo modes require isolated Docker runtimes");
  const publicUrl = new URL(
    parsed.PUBLIC_URL ?? `http://127.0.0.1:${parsed.PORT}`,
  );
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      "PUBLIC_URL must be an HTTP(S) origin without a path or credentials",
    );
  }
  const temporary = ["demo", "public"].includes(parsed.BROWSER_AUTH_MODE);
  return {
    token: parsed.AGENT_BROWSER_TOKEN,
    authMode: parsed.BROWSER_AUTH_MODE,
    host: parsed.HOST,
    port: parsed.PORT,
    publicUrl: publicUrl.origin,
    ttlMs: temporary ? 300000 : parsed.SESSION_TTL_SECONDS * 1000,
    maxSessions: parsed.MAX_SESSIONS,
    maxSessionsPerOwner: temporary ? 1 : parsed.MAX_SESSIONS_PER_MEMBER,
    maxLifetimeMs: temporary ? 600000 : parsed.SESSION_MAX_LIFETIME_SECONDS * 1000,
    publicMaxSessionsPerIp: parsed.PUBLIC_MAX_SESSIONS_PER_IP,
    trustProxy: parsed.BROWSER_TRUST_PROXY === "true",
    executablePath: parsed.CHROMIUM_EXECUTABLE_PATH,
    headless: parsed.HEADLESS === "true",
    browserMode: parsed.BROWSER_MODE,
    runtimeImage: parsed.BROWSER_RUNTIME_IMAGE,
    runtimeNetwork: parsed.BROWSER_AUTH_MODE === "demo" ? "none" as const : parsed.BROWSER_NETWORK,
    egressDenyHosts: parsed.BROWSER_EGRESS_DENY_HOSTS.split(',').map(host => host.trim()).filter(Boolean),
    dataDirectory: parsed.BROWSER_AUTH_MODE === "demo" ? `${parsed.BROWSER_DATA_DIR}/public-demo` : parsed.BROWSER_AUTH_MODE === "public" ? `${parsed.BROWSER_DATA_DIR}/public-browser` : parsed.BROWSER_DATA_DIR,
    runtimeVolume: parsed.BROWSER_DATA_VOLUME ? { name: parsed.BROWSER_DATA_VOLUME, root: parsed.BROWSER_DATA_VOLUME_ROOT ?? parsed.BROWSER_DATA_DIR } : undefined,
    desktopChromePath: parsed.DESKTOP_CHROME_PATH,
  };
}
