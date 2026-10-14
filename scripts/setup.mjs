import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Native development only; image deployments use the unified Compose installer.
const content = `# Native development; do not use this file for image deployment.
AGENT_BROWSER_TOKEN=${randomBytes(32).toString("base64url")}
HOST=127.0.0.1
PORT=3333
PUBLIC_URL=http://127.0.0.1:3333
BROWSER_AUTH_MODE=legacy
BROWSER_MODE=playwright
BROWSER_DATA_DIR=.data
`;
try {
  await writeFile(new URL("../.env", import.meta.url), content, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "Created .env with a random access token. Open .env when connecting the dashboard.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(".env already exists; existing configuration was preserved.");
}
