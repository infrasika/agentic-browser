# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=bind,source=output/runtime/packages,target=/tmp/packages \
    --mount=type=bind,source=runtime/assets.lock.json,target=/tmp/assets.lock.json \
    node -e "const fs=require('fs'),crypto=require('crypto'),lock=JSON.parse(fs.readFileSync('/tmp/assets.lock.json')); const arch=process.arch==='arm64'?'arm64':'amd64'; if(crypto.createHash('sha256').update(fs.readFileSync('/tmp/packages/chrome-'+arch+'.deb')).digest('hex')!==lock[arch==='arm64'?'chromeArm64':'chrome'].sha256)process.exit(1)" \
    && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates xvfb xauth x11vnc openbox util-linux xdotool \
      /tmp/packages/chrome-${TARGETARCH}.deb \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY LICENSE ./LICENSE
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY runtime/assets.lock.json runtime/install-extensions.mjs ./runtime/
COPY output/runtime/packages/*.crx /opt/agentic-browser/extensions/
RUN node runtime/install-extensions.mjs && mkdir -p /data /app/output/playwright && chown node:node /data /app/output/playwright
COPY tsconfig.json ./
COPY src/ ./src/
COPY runtime/PLAYWRIGHT-LICENSE ./runtime/
ARG AB_VERSION=development
ARG AB_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/infrasika/agentic-browser" \
      org.opencontainers.image.version="${AB_VERSION}" \
      org.opencontainers.image.revision="${AB_REVISION}" \
      org.opencontainers.image.description="Agentic Browser Chrome runtime with locked zkPass extensions"
USER node
CMD ["node", "--import", "tsx", "src/runtime-worker.ts"]
