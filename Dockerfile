# One tenant's Selah (6.0), for the admin console's Docker runner. Built from a prepared release, which already holds
# the built page and node_modules:  docker build -t selah:<version> <cloud root>/releases/<version>
# The admin console runs it with the tenant's folders mounted at /data, a read-only file system, no capabilities,
# memory/CPU/process limits and its ports published on 127.0.0.1 only (server/admin/runner.js).
FROM node:24.22.0-bookworm-slim

# rclone, for the tenant's own OneDrive backup (pinned and checksummed by the install script).
COPY scripts/install-rclone.sh /tmp/install-rclone.sh
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && HOME=/opt/rclone bash /tmp/install-rclone.sh \
  && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /tmp/install-rclone.sh

WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    NOTEAPP_MODE=tenant \
    NOTEAPP_TLS=0 \
    NOTEAPP_RCLONE=/opt/rclone/.local/bin/rclone \
    HOME=/tmp
EXPOSE 8080 8081
USER node
CMD ["node", "server/index.js"]
