# Selah's published image (14.1): built from a clean checkout of the public repository by GitHub Actions
# (.github/workflows/image.yml) and pushed to ghcr.io/jdt12/selah. Self-hosted installs pull it instead of building:
# Selah Cloud runs it with Docker Compose (docker/cloud/), Selah Ministry's console pulls it for each release.
# The root Dockerfile is the other way in: it wraps a release folder the console already prepared and built.
#
#   docker build -f docker/image.Dockerfile -t selah:dev .

FROM node:24.22.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build --silent

FROM node:24.22.0-bookworm-slim
# rclone, for the Selah's own off-site backup (pinned and checksummed by the install script).
COPY scripts/install-rclone.sh /tmp/install-rclone.sh
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && HOME=/opt/rclone bash /tmp/install-rclone.sh \
  && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /tmp/install-rclone.sh

WORKDIR /app
COPY --from=build /src /app

ARG VERSION=dev
LABEL org.opencontainers.image.title="Selah" \
      org.opencontainers.image.description="Notes, Bible study, teaching and preaching, on your own server" \
      org.opencontainers.image.source="https://github.com/JDT12/selah" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}"

# NOTEAPP_MODE is set by whoever runs it: tenant (Selah Ministry's console) or single (Selah Cloud's compose file).
ENV NODE_ENV=production \
    NOTEAPP_MODE=tenant \
    NOTEAPP_TLS=0 \
    NOTEAPP_RCLONE=/opt/rclone/.local/bin/rclone \
    HOME=/tmp
EXPOSE 8080 8081
USER node
CMD ["node", "server/index.js"]
