import { randomUUID } from "node:crypto";
import {
  type BrowserContext,
  type Page,
} from "playwright";
import {
  ServiceError,
  type BrowserAction,
  type BrowserWorkspace,
} from "./contracts.js";

export class ChromiumWorkspace implements BrowserWorkspace {
  private pages = new Map<string, Page>();
  private activeId = "";

  constructor(private context: BrowserContext) {
    const register = (page: Page) => {
      const id = randomUUID();
      this.pages.set(id, page);
      this.activeId = id;
      page.on("dialog", (dialog) => {
        void dialog.dismiss().catch(() => {});
      });
      page.on("close", () => {
        this.pages.delete(id);
        if (this.activeId === id)
          this.activeId = [...this.pages.keys()].at(-1) ?? "";
      });
    };
    context.on("page", register);
    for (const page of context.pages()) register(page);
  }

  private page() {
    const page = this.pages.get(this.activeId);
    if (!page || page.isClosed())
      throw new ServiceError(
        409,
        "page_closed",
        "The browser tab is closed; create a new session",
      );
    return page;
  }

  async adoptVisiblePage() {
    for (const [id, page] of this.pages) {
      if (
        await page
          .evaluate(() => document.visibilityState === "visible")
          .catch(() => false)
      ) {
        this.activeId = id;
        return;
      }
    }
  }

  async perform(action: BrowserAction): Promise<unknown> {
    const page = this.page();
    switch (action.type) {
      case "navigate":
        await page.goto(action.url, { waitUntil: "domcontentloaded" });
        break;
      case "click":
        await page.locator(action.selector).click();
        break;
      case "pointer":
        await page.mouse.click(action.x, action.y);
        break;
      case "fill":
        await page.locator(action.selector).fill(action.text);
        break;
      case "type":
        await page.keyboard.insertText(action.text);
        break;
      case "press":
        await page.keyboard.press(action.key);
        break;
      case "scroll":
        await page.mouse.wheel(action.x, action.y);
        break;
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" });
        break;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded" });
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" });
        break;
      case "selectTab": {
        const selected = this.pages.get(action.tabId);
        if (!selected)
          throw new ServiceError(404, "tab_not_found", "Tab not found");
        this.activeId = action.tabId;
        await selected.bringToFront();
        break;
      }
      case "tabs":
        return Promise.all(
          [...this.pages].map(async ([id, tab]) => ({
            id,
            active: id === this.activeId,
            url: tab.url(),
            title: await tab.title(),
          })),
        );
      case "snapshot":
        return {
          url: page.url(),
          title: await page.title(),
          // No input values, cookies, page scripts, or browser profiles are exported.
          text: (await page.locator("body").innerText()).slice(0, 20000),
          elements: await page
            .locator(
              'a,button,input,textarea,select,[role="button"],[contenteditable="true"]',
            )
            .evaluateAll((elements) =>
              elements.slice(0, 200).map((element) => ({
                tag: element.tagName.toLowerCase(),
                id: element.id || undefined,
                name: element.getAttribute("name") ?? undefined,
                type: element.getAttribute("type") ?? undefined,
                placeholder: element.getAttribute("placeholder") ?? undefined,
                label: element.getAttribute("aria-label") ?? undefined,
                text:
                  element.tagName === "TEXTAREA"
                    ? undefined
                    : element.textContent?.trim().slice(0, 150),
              })),
            ),
        };
    }
    return { url: this.page().url() };
  }

  async screenshot(maskPasswords = true) {
    const page = this.page();
    return page.screenshot({
      type: "jpeg",
      quality: 75,
      timeout: 8000,
      mask: maskPasswords
        ? page.frames().map((frame) => frame.locator('input[type="password"]'))
        : [],
      maskColor: "#24352c",
    });
  }

  async close() {
    await this.context.close();
  }
}
