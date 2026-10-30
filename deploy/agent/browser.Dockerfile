# syntax=docker/dockerfile:1
FROM docker:29.3.1-cli@sha256:18f5ab0fab739ea822819b342357947dfba235cdef438cce345ebc0c143c5b34 AS docker-cli
FROM node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json package-lock.json ./
COPY LICENSE ./LICENSE
COPY deploy/compose/licenses/Docker-CLI* ./LICENSES/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY tsconfig.json ./
COPY --chown=node:node src/ ./src/
COPY runtime/chrome-seccomp.json ./runtime/
RUN find /app/src /app/runtime -type d ! -perm -005 -exec chmod 755 {} +
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 8081 8082
CMD ["node", "--import", "tsx", "src/service.ts"]
