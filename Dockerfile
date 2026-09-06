FROM node:22.22.3-slim

RUN apt-get update && apt-get install -y git curl procps python3 make g++ cron tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --prefer-online && npm cache clean --force
COPY managed-hooks ./managed-hooks
COPY runtime ./runtime

ENV PATH="/app/node_modules/.bin:$PATH"
ENV ALPHACLAW_ROOT_DIR=/data

RUN mkdir -p /data

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "if [ -f /data/.env ]; then sed -i '/^PATH=/d' /data/.env; fi; node /app/runtime/configure-openclaw.mjs && exec alphaclaw start"]
