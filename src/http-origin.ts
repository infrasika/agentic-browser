import type { IncomingMessage } from "node:http";
import { ServiceError } from "./contracts.js";

export function requestOrigin(request: IncomingMessage, configuredUrl: string) {
  const publicUrl = new URL(configuredUrl);
  let origin = publicUrl.origin;
  const loopback =
    /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/.exec(
      request.headers.host ?? "",
    );
  const localForward =
    ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname) &&
    loopback !== null &&
    (!loopback[2] || Number(loopback[2]) <= 65535);
  if (request.headers.host !== publicUrl.host && !localForward)
    throw new ServiceError(
      403,
      "host_rejected",
      `Open the configured service origin: ${origin}`,
    );
  if (localForward)
    origin = new URL(`${publicUrl.protocol}//${request.headers.host}`).origin;
  if (request.headers.origin && request.headers.origin !== origin)
    throw new ServiceError(
      403,
      "origin_rejected",
      "Cross-origin requests are not allowed",
    );
  return origin;
}
