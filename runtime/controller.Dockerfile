# syntax=docker/dockerfile:1
# This image contains the client only. No daemon socket or host data is included.
FROM docker:29.3.1-cli@sha256:18f5ab0fab739ea822819b342357947dfba235cdef438cce345ebc0c143c5b34 AS docker-cli
FROM node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/
COPY test/ ./test/
COPY scripts/fetch-runtime-assets.py ./scripts/
COPY scripts/install.sh.in scripts/package-self-host.py scripts/release-manifest.py scripts/compose.sh scripts/public-demo.sh scripts/release-compose.sh scripts/workspace-backup.sh ./scripts/
COPY compose.yaml compose.public.yaml .env.example README.md ./
COPY docs/ ./docs/
COPY deploy/release.env deploy/nginx-public.conf ./deploy/
COPY deploy/releases/ ./deploy/releases/
COPY runtime/assets.lock.json runtime/chrome-seccomp.json ./runtime/
COPY runtime/DISTRIBUTION-NOTICES.md runtime/PLAYWRIGHT-LICENSE ./runtime/
ARG AB_VERSION=development
ARG AB_REVISION=unknown
RUN python3 scripts/package-self-host.py --version "$AB_VERSION"
RUN node -e 'require("fs").writeFileSync("build-info.json",JSON.stringify({version:process.argv[1],revision:process.argv[2]}))' "$AB_VERSION" "$AB_REVISION"
RUN mkdir /data && chown node:node /data && chmod 700 /data
LABEL org.opencontainers.image.source="https://github.com/infrasika/agentic-browser" \
      org.opencontainers.image.version="${AB_VERSION}" \
      org.opencontainers.image.revision="${AB_REVISION}" \
      org.opencontainers.image.description="Agentic Browser controller; per-session isolated browsers and human handoff"
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
