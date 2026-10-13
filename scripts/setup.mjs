import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const template = await readFile(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const content = template.replace(
  "replace-with-a-random-token-at-least-32-characters",
  randomBytes(32).toString("base64url"),
);
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
