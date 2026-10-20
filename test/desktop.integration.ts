import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { DesktopEngine } from "../src/desktop.js";
import { startService } from "./helpers.js";

test(
  "native desktop: VNC login survives a CDP detach/reconnect and revokes old viewers",
  { timeout: 60000 },
  async (t) => {
    const service = await startService(new DesktopEngine());
    const client = await chromium.launch({ headless: true });
    t.after(async () => {
      await client.close();
      await service.close();
    });
    const created = await service.request("/api/sessions", "POST", {
      purpose: "Remote desktop collaboration test",
      url: `${service.base}/demo`,
    });
    assert.equal(created.status, 201, await created.clone().text());
    const session = (await created.json()) as {
      id: string;
      humanUrl: string;
      transport: string;
    };
    assert.equal(session.transport, "desktop");
    const agent = `/api/sessions/${session.id}`;
    const human = `/api/human/${session.id}`;
    const humanToken = new URL(session.humanUrl).hash.slice(1).split(".")[1];
    const act = async (action: unknown) => {
      const response = await service.request(
        `${agent}/actions`,
        "POST",
        action,
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as { result: { text: string } };
    };
    await act({ type: "click", selector: "#username" });
    const handoff = await service.request(`${agent}/handoff`, "POST", {
      reason: "Test desktop input with a fictional account",
    });
    assert.equal(handoff.status, 200, await handoff.clone().text());
    const { revision } = (await handoff.json()) as { revision: number };
    assert.equal((await service.request(`${agent}/screen`)).status, 409);
    assert.equal(
      (
        await service.request(
          `${human}/actions`,
          "POST",
          { type: "snapshot" },
          humanToken,
        )
      ).status,
      409,
    );

    const endpoint = service.base.replace("http:", "ws:") + human + "/desktop";
    // A native desktop never streams before the human credential and revision match.
    for (const credentials of [
      { token: service.token, revision },
      { token: humanToken, revision: revision - 1 },
    ]) {
      const socket = new WebSocket(endpoint, { origin: service.base });
      await once(socket, "open");
      const closed = once(socket, "close");
      const messages: unknown[] = [];
      socket.on("message", (value) => messages.push(value));
      socket.send(JSON.stringify(credentials));
      await closed;
      assert.equal(messages.length, 0);
    }
    const badOrigin = new WebSocket(endpoint, {
      origin: "http://attacker.invalid",
    });
    const [originError] = await once(badOrigin, "error");
    assert.match(String(originError), /403/);

    const observer = new WebSocket(endpoint, { origin: service.base });
    await once(observer, "open");
    const ready = once(observer, "message");
    observer.send(JSON.stringify({ token: humanToken, revision }));
    assert.equal((await ready)[0].toString(), "ready");
    const observerClosed = once(observer, "close");

    const page = await client.newPage({
      viewport: { width: 1500, height: 1100 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 150));
    });
    await page.goto(session.humanUrl);
    await page.waitForFunction(() =>
      document
        .getElementById("message")
        ?.textContent?.includes("Connected to the remote browser"),
    );
    const canvas = page.locator("#desktop canvas");
    await page.waitForFunction(
      () => {
        const canvas =
          document.querySelector<HTMLCanvasElement>("#desktop canvas");
        if (!canvas || canvas.width < 100 || canvas.height < 100) return false;
        const pixel = canvas
          .getContext("2d")
          ?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
        return pixel && pixel[0] > 100 && pixel[1] > 100 && pixel[2] > 100;
      },
      undefined,
      { timeout: 10000 },
    );
    await canvas.focus();
    await page.keyboard.type("native-user");
    await page.keyboard.press("Tab");
    await page.keyboard.type("fake-native-password");
    await page.keyboard.press("Enter");
    // Wait for the native page and RFB framebuffer to repaint before returning control.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await mkdir("output/playwright", { recursive: true });
    await page.screenshot({
      path: "output/playwright/desktop-human-login.png",
    });
    await page.locator("#resume").click();
    await page.waitForFunction(() =>
      document.getElementById("message")?.textContent?.startsWith("Control returned"),
    );
    await observerClosed;
    assert.equal(await canvas.count(), 0);
    await act({ type: "reload" });
    const account = await act({ type: "snapshot" });
    assert.match(account.result.text, /Signed in: native-user/);
    await act({ type: "click", selector: "#continue" });
    assert.match((await act({ type: "snapshot" })).result.text, /Task complete/);
    assert.deepEqual(errors, []);

    // Reloading a viewer and losing its network must preserve the human lease.
    await page.locator("#takeover").click();
    await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Connected" && !!document.querySelector("#desktop canvas"));
    const beforeReconnect = service.registry.get(session.id).info();
    assert.equal(await page.locator("#expiry-warning").isVisible(), true);
    await page.locator("#extend").click();
    await page.waitForFunction(() => document.getElementById("message")?.textContent === "Session extended.");
    assert.ok(service.registry.get(session.id).expiresAt > Date.parse(beforeReconnect.expiresAt));
    await page.reload();
    await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Connected" && !!document.querySelector("#desktop canvas"));
    await page.context().setOffline(true);
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-key="Enter"]')?.disabled && !document.querySelector("#desktop canvas"));
    assert.equal(service.registry.get(session.id).info().control, "human");
    assert.equal((await service.request(`${agent}/screen`)).status, 409);
    await page.context().setOffline(false);
    await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Connected" && !!document.querySelector("#desktop canvas"));
    assert.equal(service.registry.get(session.id).info().revision, beforeReconnect.revision);
    await page.locator("#resume").click();
    await page.waitForFunction(() => document.getElementById("message")?.textContent?.startsWith("Control returned"));
    assert.match((await act({ type: "snapshot" })).result.text, /Task complete/);

    // An old human lease is invalid even when a fresh handoff later reopens VNC.
    await service.request(`${agent}/handoff`, "POST", { reason: "Take control again" });
    const stale = new WebSocket(endpoint, { origin: service.base });
    await once(stale, "open");
    const staleClosed = once(stale, "close");
    stale.send(JSON.stringify({ token: humanToken, revision }));
    await staleClosed;
    const other = await service.request("/api/sessions", "POST", {
      url: `${service.base}/demo`,
    });
    const otherSession = (await other.json()) as { id: string };
    const clean = await service.request(
      `/api/sessions/${otherSession.id}/actions`,
      "POST",
      { type: "snapshot" },
    );
    assert.doesNotMatch(
      JSON.stringify(await clean.json()),
      /Signed in: native-user/,
    );
  },
);
