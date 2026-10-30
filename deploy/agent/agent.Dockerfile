# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d AS build
WORKDIR /app
ENV SCARF_ANALYTICS=false NODE_OPTIONS=--max-old-space-size=3072
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ git && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund
RUN npm run frontend
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node selfhost/ /app/selfhost/
# The installation runs as the host owner's UID, which need not be node (1000).
# Build contexts are private (umask 0077); application code must remain readable
# and existing executables traversable after COPY --chown=node:node.
RUN chmod -R a+rX /app
RUN mkdir -p /app/uploads /app/client/public/images /app/logs && chown -R node:node /app/uploads /app/client/public/images /app/logs
USER node
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=1536
EXPOSE 3080
CMD ["node", "selfhost/start.mjs"]
