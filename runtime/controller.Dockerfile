# syntax=docker/dockerfile:1
# This image contains the client only. No daemon socket or host data is included.
FROM docker:29.3.1-cli@sha256:18f5ab0fab739ea822819b342357947dfba235cdef438cce345ebc0c143c5b34 AS docker-cli
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
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
COPY scripts/install.sh.in scripts/package-self-host.py scripts/release-manifest.py scripts/compose.sh scripts/public-demo.sh scripts/release-compose.sh ./scripts/
COPY compose.yaml compose.public.yaml .env.example README.md ./
COPY docs/ ./docs/
COPY deploy/release.env deploy/nginx-public.conf ./deploy/
COPY deploy/releases/ ./deploy/releases/
COPY runtime/assets.lock.json runtime/chrome-seccomp.json ./runtime/
COPY runtime/DISTRIBUTION-NOTICES.md runtime/PLAYWRIGHT-LICENSE ./runtime/
COPY runtime/README.md ./runtime/
RUN python3 scripts/package-self-host.py
RUN mkdir /data && chown node:node /data && chmod 700 /data
ARG AB_VERSION=development
ARG AB_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/infrasika/agentic-browser" \
      org.opencontainers.image.version="${AB_VERSION}" \
      org.opencontainers.image.revision="${AB_REVISION}" \
      org.opencontainers.image.description="Agentic Browser controller; per-session isolated browsers and human handoff"
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
