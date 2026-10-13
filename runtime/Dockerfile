# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV DEBIAN_FRONTEND=noninteractive BROWSER_MODE=desktop BROWSER_DATA_DIR=/data
RUN --mount=type=bind,source=output/runtime/packages,target=/tmp/packages \
    --mount=type=bind,source=runtime/assets.lock.json,target=/tmp/assets.lock.json \
    node -e "const fs=require('fs'),crypto=require('crypto'); if(crypto.createHash('sha256').update(fs.readFileSync('/tmp/packages/chrome.deb')).digest('hex')!==JSON.parse(fs.readFileSync('/tmp/assets.lock.json')).chrome.sha256)process.exit(1)" \
    && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates xvfb xauth x11vnc openbox util-linux xdotool \
      /tmp/packages/chrome.deb \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY runtime/assets.lock.json runtime/install-extensions.mjs ./runtime/
COPY output/runtime/packages/*.crx /opt/agentic-browser/extensions/
RUN node runtime/install-extensions.mjs && mkdir -p /data /app/output/playwright && chown node:node /data /app/output/playwright
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/
COPY test/ ./test/
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
