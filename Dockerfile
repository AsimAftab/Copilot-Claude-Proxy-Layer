# syntax=docker/dockerfile:1

# Node 20+ is required: the built output uses `import ... with { type: 'json' }`
# import attributes, which Node 18 does not support (and 18 is EOL).
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Production stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS production

# tini reaps zombies and forwards SIGTERM so `docker stop` is clean.
RUN apk add --no-cache tini

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# OAuth tokens live here. Mount a volume so authentication survives
# `docker rm` and image rebuilds.
ENV COPILOT_PROXY_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
