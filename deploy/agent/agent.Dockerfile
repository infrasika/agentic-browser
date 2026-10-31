# syntax=docker/dockerfile:1
FROM docker:29.3.1-cli@sha256:18f5ab0fab739ea822819b342357947dfba235cdef438cce345ebc0c143c5b34 AS docker-cli
FROM node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d AS build
WORKDIR /app
ENV SCARF_ANALYTICS=false NODE_OPTIONS=--max-old-space-size=3072
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ git && rm -rf /var/lib/apt/lists/*
# Operations change independently of LibreChat's dependency and frontend build.
COPY --exclude=selfhost . .
RUN npm ci --no-audit --no-fund
RUN npm run frontend
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# The installation runs as the host owner's UID, which need not be node (1000).
# Apply readability while copying: a later recursive chmod copies the entire
# application into another overlay layer and causes unnecessary disk writes.
COPY --from=build --chown=node:node --chmod=a+rX /app /app
COPY --chown=node:node --chmod=a+rX selfhost/ /app/selfhost/
RUN mkdir -p /app/uploads /app/client/public/images /app/logs && chown -R node:node /app/uploads /app/client/public/images /app/logs
USER node
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=1536
EXPOSE 3080
CMD ["node", "selfhost/start.mjs"]
