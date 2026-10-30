import { z } from "zod";

export const webUrl = z
  .string()
  .max(8192)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Use an HTTP(S) URL without embedded credentials");

const selector = z.string().min(1).max(2000);
const coordinate = z.number().finite().min(0).max(10000);
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: webUrl }).strict(),
  z.object({ type: z.literal("click"), selector }).strict(),
  z
    .object({ type: z.literal("pointer"), x: coordinate, y: coordinate })
    .strict(),
  z
    .object({ type: z.literal("fill"), selector, text: z.string().max(16000) })
    .strict(),
  z.object({ type: z.literal("type"), text: z.string().max(16000) }).strict(),
  z
    .object({ type: z.literal("press"), key: z.string().min(1).max(80) })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: z.number().finite().min(-5000).max(5000),
      y: z.number().finite().min(-5000).max(5000),
    })
    .strict(),
  z.object({ type: z.literal("back") }).strict(),
  z.object({ type: z.literal("forward") }).strict(),
  z.object({ type: z.literal("reload") }).strict(),
  z.object({ type: z.literal("snapshot") }).strict(),
  z.object({ type: z.literal("tabs") }).strict(),
  z.object({ type: z.literal("selectTab"), tabId: z.string().uuid() }).strict(),
]);
export type BrowserAction = z.infer<typeof actionSchema>;
