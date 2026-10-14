import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { apiRequester, createPrivateMcpServer } from "./private-mcp-server.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const token = process.env.AGENT_BROWSER_TOKEN;
const base =
  process.env.AGENT_BROWSER_URL ??
  process.env.PUBLIC_URL ??
  "http://127.0.0.1:3333";
const viewOrigin = process.env.AGENT_BROWSER_VIEW_URL;
try {
  for (const value of [base, viewOrigin].filter(Boolean)) {
    const url = new URL(value!);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin');
  }
} catch { console.error('AGENT_BROWSER_URL and AGENT_BROWSER_VIEW_URL must be HTTP(S) origins without credentials or paths.'); process.exit(1); }
if (!token || token.length < 32) {
  console.error("Set AGENT_BROWSER_TOKEN before starting the MCP adapter.");
  process.exit(1);
}
const server = createPrivateMcpServer(apiRequester(base, token), viewOrigin);
await server.connect(new StdioServerTransport());
